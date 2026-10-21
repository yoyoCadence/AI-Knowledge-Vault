import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { ReadingStatus } from "@/infrastructure/database/schema";
import { DISPLAY_TIME_ZONE } from "@/lib/format";

/**
 * Library filters (FR-SRCH-3, API_CONTRACT §5 and §7), shared by the library list and search
 * so both mean the same thing. Each filter is a condition on one artifact row, given as the
 * SQL reference the calling query uses for it (`"artifacts"` or an alias). Callers pass
 * values validated by their route (ids are UUIDs, dates are YYYY-MM-DD). The reading filters
 * are the actor's own: they need the actor's user id.
 */
export interface LibraryFilters {
  tagId?: string;
  projectId?: string;
  /** In this collection or any of its subcollections. */
  collectionId?: string;
  /** Content kind of the current version. */
  kind?: string;
  /** Source model of the current version, exactly as recorded. */
  sourceModel?: string;
  /** Imported on or after this day (display time zone). */
  from?: string;
  /** Imported on or before this day (display time zone). */
  to?: string;
  /** The actor marked it a favorite. */
  favorite?: boolean;
  /** The actor's reading status; "unread" includes artifacts they never touched. */
  readingStatus?: ReadingStatus;
}

export function filterConditions(
  artifact: SQLWrapper,
  filters: LibraryFilters,
  userId?: string,
): SQL[] {
  const conditions: SQL[] = [];
  const state = (condition: SQL) => {
    if (!userId) throw new Error("reading filters need the actor's user id");
    return sql`exists (select 1 from artifact_reading_states frs where frs.artifact_id = ${artifact}.id and frs.user_id = ${userId} and ${condition})`;
  };
  if (filters.favorite) conditions.push(state(sql`frs.is_favorite`));
  if (filters.readingStatus === "unread") {
    conditions.push(sql`not ${state(sql`frs.status <> 'unread'`)}`);
  } else if (filters.readingStatus) {
    conditions.push(state(sql`frs.status = ${filters.readingStatus}`));
  }
  const version = (column: SQL, value: string) =>
    sql`exists (select 1 from artifact_versions fv where fv.id = ${artifact}.current_version_id and ${column} = ${value})`;
  if (filters.tagId) {
    conditions.push(
      sql`exists (select 1 from artifact_tags ft where ft.artifact_id = ${artifact}.id and ft.tag_id = ${filters.tagId})`,
    );
  }
  if (filters.collectionId) {
    conditions.push(
      // Uncorrelated, so Postgres computes the subtree's artifacts once. `union` (not `union
      // all`) ends the recursion even if the tree ever held a cycle.
      sql`${artifact}.id in (select fci.artifact_id from collection_items fci where fci.collection_id in (with recursive sub(id) as (select ${filters.collectionId}::uuid union select fc.id from collections fc join sub on fc.parent_id = sub.id) select id from sub))`,
    );
  }
  if (filters.projectId) {
    // A deleted project filters to nothing, as if it did not exist.
    conditions.push(
      sql`${artifact}.project_id = ${filters.projectId} and exists (select 1 from research_projects fp where fp.id = ${filters.projectId} and fp.deleted_at is null)`,
    );
  }
  if (filters.kind) conditions.push(version(sql`fv.content_kind`, filters.kind));
  if (filters.sourceModel) conditions.push(version(sql`fv.source_model`, filters.sourceModel));
  if (filters.from) {
    conditions.push(
      sql`${artifact}.created_at >= (${filters.from}::date)::timestamp at time zone ${DISPLAY_TIME_ZONE}`,
    );
  }
  if (filters.to) {
    conditions.push(
      sql`${artifact}.created_at < ((${filters.to}::date) + 1)::timestamp at time zone ${DISPLAY_TIME_ZONE}`,
    );
  }
  return conditions;
}

/** True when any filter is set. */
export function hasFilters(filters: LibraryFilters): boolean {
  return Object.values(filters).some((value) => value !== undefined && value !== "");
}
