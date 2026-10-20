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
   `\p{L}\p{N}`, so quoting is trivial and injection-proof.

The query tokenizer uses the same normalization:

- A **CJK query run** of length ≥ 2 becomes a phrase of its bigrams joined by `<->`, which
  requires adjacency, so `城市熱島` matches only text containing that exact sequence.
  Length 1 becomes the unigram.
- A **Latin term** becomes a prefix match `term:*` (partial keywords, e.g. `therm` →
  `thermal`).
- Multiple terms are joined with `&` (AND). A quoted phrase "…" keeps adjacency for Latin too.
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
WITH q AS (SELECT $tsquery::tsquery AS query),
chunk_hits AS (
  SELECT c.artifact_id, c.id AS chunk_id, ts_rank_cd(c.search_vector, q.query) AS rank
  FROM content_chunks c, q
  JOIN artifacts a ON a.id = c.artifact_id
  WHERE c.workspace_id = $ws AND a.deleted_at IS NULL
    AND c.artifact_version_id = a.current_version_id
    AND c.search_vector @@ q.query
),
meta_hits AS (
  SELECT d.artifact_id, ts_rank_cd(d.search_vector, q.query) * 2 AS rank   -- metadata boost
  FROM artifact_search_documents d, q
  JOIN artifacts a ON a.id = d.artifact_id
  WHERE d.workspace_id = $ws AND a.deleted_at IS NULL AND d.search_vector @@ q.query
)
SELECT artifact_id, max(rank) … GROUP BY artifact_id ORDER BY score DESC LIMIT $n OFFSET $m
```

Filters are applied in the same query: project, collection, tag, source model, created or
research date range, and content kind. Sorting: relevance (default), newest, or title.

**Snippets and highlight.** For each result's best chunk, the app finds match spans in the
chunk text with the same normalization and builds a snippet of about 160 characters around
the first span. It returns `segments: [{text, highlight: boolean}]`. The UI renders
segments as text nodes, with no HTML injection.

## 5. Permission filtering

`workspace_id = actor.workspaceId` and `deleted_at IS NULL` are in every query, and that
filter is the only route into search. There is no public search endpoint in Phase 1. A
future public showcase search would use a separate query restricted to
`visibility = 'public'`.

## 6. Indexing lifecycle

- After an extraction commits, a `search.index_version` job (idempotency key
  `search:{versionId}:{tokenizerVersion}`) chunks the active extraction and writes
  `content_chunks`, replacing earlier chunks for that version in one transaction.
- Metadata changes (title, tags, notes) call `reindexArtifactMetadata(artifactId)`
  synchronously. It is a single row, so this is cheap.
- A tokenizer upgrade bumps `TOKENIZER_VERSION`, and a `search.reindex_all` job rebuilds
  everything.

## 7. Validation

`tests/integration/search.test.ts` checks the following against real Postgres with
Traditional Chinese fixtures:

- 2-character word (`熱島`)
- 4-character phrase (`城市熱島`)
- no false positive for a non-adjacent sequence
- mixed Chinese and English
- English prefix
- full-width input (`ＡＩ` → `ai`)
- private-workspace isolation
- snippet highlight offsets

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
