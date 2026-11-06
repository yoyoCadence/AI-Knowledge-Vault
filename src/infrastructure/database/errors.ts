/** Postgres SQLSTATE codes the app reacts to. */
export const PG_UNIQUE_VIOLATION = "23505";
/** `statement_timeout` (or a cancel request) stopped the statement. */
export const PG_QUERY_CANCELED = "57014";

/** The Postgres error code under Drizzle's wrapper, if any. */
export function pgErrorCode(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}
