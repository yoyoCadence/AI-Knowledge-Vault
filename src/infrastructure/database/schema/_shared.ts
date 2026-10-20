import { sql, type SQL } from "drizzle-orm";
import { timestamp, uuid } from "drizzle-orm/pg-core";
import { newId } from "@/lib/ids";

/** UUIDv7 primary key generated in the application (ADR-008). */
export const idColumn = () =>
  uuid("id")
    .primaryKey()
    .$defaultFn(() => newId());

export const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdateFn(() => new Date());

/**
 * Builds `column IN ('a','b')` for CHECK constraints on text enums (DATA_MODEL.md §1 rule 9).
 * DDL cannot use bind parameters, so values are inlined as escaped literals. Only ever called
 * with compile-time constant arrays from schema files, never with user input.
 */
export function oneOf(column: SQL | { name: string }, values: readonly string[]): SQL {
  const columnSql = "name" in column ? sql.identifier(column.name) : column;
  const literals = values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");
  // eslint-disable-next-line no-restricted-syntax -- schema DDL constants (see doc comment)
  return sql`${columnSql} in (${sql.raw(literals)})`;
}
