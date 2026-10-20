import { and, eq, lt, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { KeysetCursor } from "@/lib/cursor";

/**
 * Newest-first keyset pagination on `(created_at, id)` at full microsecond precision
 * (see `src/lib/cursor.ts`): `cursorTimestamp` selects the exact value for the next cursor and
 * `beforeCursor` filters rows strictly after it in `ORDER BY created_at DESC, id DESC`.
 */
export function cursorTimestamp(createdAt: AnyColumn): SQL<string> {
  return sql<string>`to_char(${createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

export function beforeCursor(
  createdAt: AnyColumn,
  id: AnyColumn,
  cursor: KeysetCursor | undefined,
): SQL | undefined {
  if (!cursor) return undefined;
  const at = sql`${cursor.createdAt}::timestamptz`;
  return or(lt(createdAt, at), and(eq(createdAt, at), lt(id, cursor.id)));
}
