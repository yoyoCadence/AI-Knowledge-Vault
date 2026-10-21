import { sql } from "drizzle-orm";
import type { DbExecutor } from "@/infrastructure/database/client";
import type { Actor } from "@/modules/auth";
import { normalizeForSearch, parseQuery, type QueryTerm, termTsqueries } from "./tokenizer";

/**
 * Keyword search over the actor's workspace (docs/SEARCH_DESIGN.md §4–5). One parameterized
 * query matches every term on its own against the current version's chunks and the artifact
 * metadata document, keeps artifacts where all terms matched somewhere, and ranks them.
 * Deleted artifacts and other workspaces are excluded in the same query, never afterwards.
 */

export const SEARCH_PAGE_SIZE = 20;
const MAX_OFFSET = 1_000;
const SNIPPET_LENGTH = 160;

export interface SnippetSegment {
  text: string;
  highlight: boolean;
}

export interface SearchHit {
  id: string;
  title: string;
  summary: string | null;
  contentKind: string | null;
  score: number;
  snippet: { segments: SnippetSegment[]; truncatedStart: boolean; truncatedEnd: boolean } | null;
}

/**
 * Highlights the query's terms in `text` (same normalization as indexing) and cuts a snippet
 * of about 160 characters around the first match. Returns plain segments: callers render them
 * as text, never as HTML. Normalization is per code point, so offsets map back exactly.
 */
export function buildSnippet(text: string, terms: QueryTerm[], maxLength = SNIPPET_LENGTH) {
  const codePoints = [...text];
  let normalized = "";
  const origin: number[] = []; // normalized UTF-16 index → code point index
  codePoints.forEach((char, index) => {
    const piece = normalizeForSearch(char);
    normalized += piece;
    for (let unit = 0; unit < piece.length; unit += 1) origin.push(index);
  });

  const spans: [number, number][] = [];
  for (const term of terms) {
    for (const needle of term.highlights) {
      if (!needle) continue;
      for (
        let at = normalized.indexOf(needle);
        at !== -1;
        at = normalized.indexOf(needle, at + 1)
      ) {
        // Words match at a word start (prefix search); CJK runs match anywhere.
        const before = normalized[at - 1];
        if (term.prefix && before && /[\p{L}\p{N}]/u.test(before)) continue;
        spans.push([origin[at]!, origin[at + needle.length - 1]! + 1]);
      }
    }
  }
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: [number, number][] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }

  const first = merged[0];
  const start = first ? Math.max(0, Math.min(first[0] - 40, codePoints.length - maxLength)) : 0;
  const end = Math.min(codePoints.length, start + maxLength);
  const segments: SnippetSegment[] = [];
  let cursor = start;
  for (const [from, to] of merged) {
    if (to <= start || from >= end) continue;
    const a = Math.max(from, start);
    const b = Math.min(to, end);
    if (a > cursor) segments.push({ text: codePoints.slice(cursor, a).join(""), highlight: false });
    segments.push({ text: codePoints.slice(a, b).join(""), highlight: true });
    cursor = b;
  }
  if (cursor < end)
    segments.push({ text: codePoints.slice(cursor, end).join(""), highlight: false });
  return { segments, truncatedStart: start > 0, truncatedEnd: end < codePoints.length };
}

type Row = {
  id: string;
  title: string;
  summary: string | null;
  content_kind: string | null;
  score: number | string;
  chunk_text: string | null;
};

export async function searchArtifacts(
  db: DbExecutor,
  actor: Actor,
  input: { q: string; offset?: number; limit?: number; tagId?: string },
): Promise<{ items: SearchHit[]; nextOffset: number | null; terms: QueryTerm[] }> {
  const terms = parseQuery(input.q);
  const termQueries = termTsqueries(terms);
  if (termQueries.length === 0) return { items: [], nextOffset: null, terms };
  const limit = Math.min(Math.max(input.limit ?? SEARCH_PAGE_SIZE, 1), 50);
  const offset = Math.min(Math.max(input.offset ?? 0, 0), MAX_OFFSET);
  const workspaceId = actor.workspaceId;
  // Filters apply where candidates are chosen, in the same scoped query (never afterwards).
  const tagFilter = input.tagId
    ? sql`and exists (select 1 from artifact_tags f where f.artifact_id = a.id and f.tag_id = ${input.tagId})`
    : sql``;
  const termRows = sql.join(
    termQueries.map((query, index) => sql`(${index + 1}::int, ${query}::tsquery)`),
    sql`, `,
  );

  const result = await db.execute<Row>(sql`
    with terms (term_no, query) as (values ${termRows}),
    -- Any term: narrows rows through the GIN indexes and ranks them.
    any_term as (select ${termQueries.join(" | ")}::tsquery as query),
    chunk_rows as (
      select c.artifact_id, c.id, c.ordinal, c.search_vector,
        ts_rank_cd(c.search_vector, q.query) as rank
      from content_chunks c
      join artifacts a on a.id = c.artifact_id
      cross join any_term q
      where c.workspace_id = ${workspaceId} and a.workspace_id = ${workspaceId}
        and a.deleted_at is null
        and c.artifact_version_id = a.current_version_id
        and c.search_vector @@ q.query
        ${tagFilter}
    ),
    meta_rows as (
      select d.artifact_id, d.search_vector,
        ts_rank_cd(d.search_vector, q.query) * 2 as rank -- metadata boost
      from artifact_search_documents d
      join artifacts a on a.id = d.artifact_id
      cross join any_term q
      where d.workspace_id = ${workspaceId} and a.workspace_id = ${workspaceId}
        and a.deleted_at is null
        and d.search_vector @@ q.query
        ${tagFilter}
    ),
    -- Which term matched which row. One aggregation (no joins back onto its own result: the
    -- planner cannot estimate a HAVING, and nested loops over it grew quadratically).
    hits as (
      select r.artifact_id, t.term_no, r.id as chunk_id, r.ordinal, r.rank, false as meta
      from chunk_rows r join terms t on r.search_vector @@ t.query
      union all
      select m.artifact_id, t.term_no, null::uuid, null::int, m.rank, true
      from meta_rows m join terms t on m.search_vector @@ t.query
    ),
    scored as (
      select artifact_id,
        (array_agg(chunk_id order by rank desc, ordinal) filter (where not meta))[1] as chunk_id,
        coalesce(max(rank) filter (where not meta), 0)
          + coalesce(max(rank) filter (where meta), 0) as score
      from hits
      group by artifact_id
      -- Every term matched somewhere in the artifact.
      having count(distinct term_no) = ${termQueries.length}::int
    )
    select a.id, a.title, a.summary, v.content_kind, s.score, ch.text as chunk_text
    from scored s
    join artifacts a on a.id = s.artifact_id
    left join artifact_versions v on v.id = a.current_version_id
    left join content_chunks ch on ch.id = s.chunk_id
    order by s.score desc, a.created_at desc, a.id
    limit ${limit + 1} offset ${offset}
  `);
  const rows = result.rows.slice(0, limit);
  const items = rows.map((row) => {
    const source = row.chunk_text ?? row.summary ?? row.title;
    return {
      id: row.id,
      title: row.title,
      summary: row.summary,
      contentKind: row.content_kind,
      score: Number(row.score),
      snippet: source ? buildSnippet(source, terms) : null,
    };
  });
  const more = result.rows.length > limit && offset + limit <= MAX_OFFSET;
  return { items, nextOffset: more ? offset + limit : null, terms };
}
