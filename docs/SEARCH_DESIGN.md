# Search Design

Implements FR-SRCH-1 through FR-SRCH-4 (Phase 1B) and prepares FR-SRCH-5 (Phase 2).
Decision record: ADR-009.

## 1. Problem

PostgreSQL's built-in parsers split on whitespace and punctuation. Traditional Chinese has
neither between words, so `to_tsvector('simple', '細胞沒有藍圖')` yields **one** token, and a
search for `藍圖` finds nothing. Neon offers no Chinese segmentation extension. `pg_trgm`
can't use its index for 1–2 character patterns, which covers most Chinese words, and its
behaviour depends on the database `LC_CTYPE`.

## 2. Approach: application tokenizer → `tsvector`

`src/modules/search/tokenizer.ts` (versioned by `TOKENIZER_VERSION`):

1. **Normalize:** Unicode NFKC (full-width → half-width, compatibility forms), then
   lower-case.
2. **Segment** into runs:
   - **Han/CJK run** (`\p{Script=Han}`, plus Hiragana, Katakana and Hangul): emit every
     **bigram** (`形態`, `態發`, `發生`) and every **unigram** (`形`, `態`, …), each with its
     position.
   - **Latin/number run** (`[\p{L}\p{N}]` outside CJK): emit the word. Pure-digit tokens are
     kept (years, versions). Words longer than 64 characters are truncated.
   - Everything else (punctuation, whitespace) separates runs and increments position.
3. **Positions:** a single counter advances by one per CJK character, per Latin word, and per
   separator run, so that phrases never match across runs. A bigram takes the position of
   its first character, and a unigram takes its own character's position. Consecutive
   bigrams are therefore at consecutive positions, which is what `<->` needs.
4. **Output:** a `tsvector` **literal** with explicit positions and weights, for example
   `'形態':1A '態發':2A '形':1A …`, bound as a parameter and cast with `$1::tsvector`.
   `to_tsvector` would renumber positions, so it is not used. Lexemes contain only
   `\p{L}\p{N}`, so quoting is trivial and injection-proof. The parts of one vector (title,
   description, source fields) are laid out 100 positions apart, more than any phrase
   distance, so a phrase never matches across two fields.

The query tokenizer uses the same normalization:

- A **CJK query run** of length ≥ 2 becomes a phrase of its bigrams joined by `<->`, which
  requires adjacency, so `城市熱島` matches only text containing that exact sequence.
  Length 1 becomes the unigram.
- A **Latin term** becomes a prefix match `term:*` (partial keywords, e.g. `therm` →
  `thermal`).
- Multiple terms are AND-ed **per artifact**: each term is matched on its own, and an
  artifact qualifies when every term matched somewhere in it, in any chunk of its current
  version or in its metadata document. So `對策 綠廊` finds a document with 對策 in its
  description and 綠廊 in a later section. Phrases (CJK runs, quoted text) still match
  within one chunk or one field. A quoted phrase "…" keeps adjacency for Latin too.
- Up to 16 terms. Each lexeme is escaped by construction, since tokens contain only
  `\p{L}\p{N}`, so user input can never inject tsquery operators.

## 3. Why chunks

`tsvector` positions saturate at 16,383. Bigram plus unigram indexing produces about two
lexeme positions per CJK character, so a 10,000-character report would exceed the limit and
break phrase matching. Content is therefore indexed per **chunk**:

- Chunks follow `document_sections` boundaries and split sections longer than
  **1,200 characters** at paragraph or sentence boundaries, with a 100-character overlap.
- Each chunk row stores `text`, `char_start`/`char_end` in the extracted plain text,
  `section_id`, and `search_vector`.
- These chunks are the **same** units Phase 2 will embed, so RAG citations get exact
  locations for free.

Artifact-level metadata (title A, tags and description B, notes and source info C) lives in
`artifact_search_documents`, one row per artifact.

## 4. Query execution

```sql
WITH terms (term_no, query) AS (VALUES (1, $t1::tsquery), (2, $t2::tsquery) …),
any_term AS (SELECT $t1_or_t2::tsquery AS query),        -- GIN narrowing and ranking
chunk_rows AS (                                        -- current-version chunks, any term
  SELECT c.* FROM content_chunks c JOIN artifacts a ON a.id = c.artifact_id, any_term q
  WHERE c.workspace_id = $ws AND a.workspace_id = $ws AND a.deleted_at IS NULL
    AND c.artifact_version_id = a.current_version_id AND c.search_vector @@ q.query
),
meta_rows AS ( … same for artifact_search_documents … ),
matched AS (                                           -- every term somewhere in the artifact
  SELECT artifact_id FROM (
    SELECT r.artifact_id, t.term_no FROM chunk_rows r JOIN terms t ON r.search_vector @@ t.query
    UNION
    SELECT m.artifact_id, t.term_no FROM meta_rows m JOIN terms t ON m.search_vector @@ t.query
  ) hits GROUP BY artifact_id HAVING count(DISTINCT term_no) = $termCount
)
-- score = best chunk's ts_rank_cd(any_term) + 2 × the metadata document's (metadata boost);
-- the best chunk is also the snippet source.
SELECT … ORDER BY score DESC, created_at DESC, id LIMIT $n OFFSET $m
```

Filters are applied in the same query: project, collection, tag, source model, created or
research date range, and content kind. Sorting: relevance (default), newest, or title.

**Snippets and highlight.** For each result's best chunk, the app finds match spans in the
chunk text with the same normalization and builds a snippet of about 160 characters around
the first span. Normalization is applied per code point, so every match maps back to exact
offsets in the original text (a combining sequence that NFKC would compose is the one case
where a highlight can differ from the index). Words match only at a word start (prefix
search); CJK runs match anywhere. It returns `segments: [{text, highlight: boolean}]`. The UI
renders segments as text nodes and `<mark>` elements, with no HTML injection.

**Built so far:** `q` and `offset` (PR 12; 20 per page, offsets up to 1,000) and `tag`
(PR 13: an `exists` on `artifact_tags`, applied where chunk and metadata candidates are
chosen). The other filters (project, collection, source model, kind, dates), sorting and
totals come with the rest of P1B-ORG.

## 5. Permission filtering

`workspace_id = actor.workspaceId` and `deleted_at IS NULL` are in every query, and that
filter is the only route into search. There is no public search endpoint in Phase 1. A
future public showcase search would use a separate query restricted to
`visibility = 'public'`.

## 6. Indexing lifecycle

- `saveExtraction` enqueues a `search.index_version` job in the same transaction that saves
  the extraction (import, re-extraction and restore all go through it). The idempotency key
  is `search.index_version:{extractionId}:{tokenizerVersion}`, so a re-extraction or a
  tokenizer upgrade indexes again and a retry does not. A restored version without archived
  text (an image) is queued by version instead (`…:version:{versionId}:…`), so its title
  is searchable even if re-extraction fails for good.
- The job (`indexVersion`) locks the version row, replaces its `content_chunks` with chunks
  of the active extraction, records what they were built from in `search_index_states`
  (extraction, tokenizer version, chunk count; also when the text is empty), and rebuilds
  the artifact's `artifact_search_documents` row (title A; description, summary and tag
  names B, each tag its own field so a phrase never runs from one tag into the next; source
  platform, model, author and original filename C), all in one transaction.
  Rebuilding the metadata document locks the artifact row first, so a job for an older
  version can never overwrite the document of a version that became current meanwhile.
- Chunk boundaries never split a surrogate pair (emoji, CJK Extension B characters).
- Tag changes (add, remove, rename, merge, delete) call `indexArtifactMetadata` for every
  affected artifact in the same transaction, in artifact-id order (no deadlock between two
  tag operations). Other metadata edits will do the same once metadata editing exists
  (P1B-DETAIL).
- `search.reindex_all` runs daily from the maintenance scheduler. It queues index jobs only
  for current versions without a `search_index_states` row for their active extraction and
  the current tokenizer, and for artifacts without a current metadata document (keyed per
  day, so a job that failed for good is retried the next day). That makes it the backfill
  after deploy and after a `TOKENIZER_VERSION` bump. It decides from recorded state, never
  by guessing from the text.

## 7. Validation

`tests/integration/search/search.test.ts` checks the following against real Postgres with
Traditional Chinese fixtures:

- 2-character word (`熱島`)
- 4-character phrase (`城市熱島`)
- no false positive for a non-adjacent sequence
- mixed Chinese and English
- English prefix
- full-width input (`ＡＩ` → `ai`)
- private-workspace isolation
- snippet highlight offsets
- AND across the artifact: one term in the description and one in the body, or in two
  different sections (chunks)
- no phrase match across two metadata fields
- ranking: a title hit above a body-only hit
- backfill from recorded state: a current version whose own job never ran is re-queued even
  though its artifact has a metadata document; a version without an extraction still gets
  its metadata document
- the metadata document follows the version that is current when it commits (row lock)

`tests/unit/search/*` covers the tokenizer and chunker, including surrogate pairs at chunk
cuts and word truncation. `tests/integration/backup/roundtrip.test.ts` checks that a restore
queues an index job for every restored version.

## 8. Phase 2: semantic and hybrid search

- Embeddings per `content_chunks` row go in `embedding_records` (pgvector, HNSW index), keyed
  by `(chunk_id, model, model_version)` with `content_hash`, so stale vectors are detectable
  and regenerable.
- Hybrid ranking uses reciprocal rank fusion of keyword rank and vector rank. Exact-term
  boosting (years, tickers, technical IDs matched by regex) keeps precision for exact tokens.
- Vectors are never the only copy of anything. Chunks and originals remain authoritative.

## 9. Known limitations

- There is no Simplified↔Traditional folding; `形态` does not match `形態`. Planned: OpenCC
  conversion at normalization (P2-SEARCH-OPENCC).
- Bigram matching can match across word boundaries (`會議` inside `機會議題`). This is
  acceptable for recall-oriented personal search, and ranking mitigates it.
- There is no stemming for English. Prefix matching covers most needs.
- Postgres keeps at most 256 positions per lexeme in one `tsvector`. In very repetitive text
  (a long table of `0`s, say), later occurrences of such a lexeme still match single-token
  queries but drop out of phrase matches. Chunks of 1,200 characters keep this rare.
- Ranking sums the best chunk and the metadata document. It does not count how many chunks
  match. Good enough for a personal library; revisit with hybrid ranking (§8).
