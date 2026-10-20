import { AppError } from "./errors";
import { isUuid } from "./ids";

/**
 * Opaque keyset cursor `(createdAt, id)` for newest-first listings (docs/API_CONTRACT.md §1).
 *
 * `createdAt` is the row's exact database timestamp as UTC ISO text with microseconds
 * (see `cursorTimestamp`). A JS `Date` would truncate to milliseconds, and rows created in
 * the same millisecond as a page's last row would then be skipped.
 */
export interface KeysetCursor {
  createdAt: string;
  id: string;
}

const EXACT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

export function encodeCursor(cursor: KeysetCursor | null): string | null {
  if (!cursor) return null;
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.id])).toString("base64url");
}

/** Decodes a client-supplied cursor; throws VALIDATION_FAILED for anything malformed. */
export function decodeCursor(value: string | undefined): KeysetCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (Array.isArray(parsed) && parsed.length === 2) {
      const [createdAt, id] = parsed as [unknown, unknown];
      if (
        typeof createdAt === "string" &&
        EXACT_TIMESTAMP.test(createdAt) &&
        !Number.isNaN(Date.parse(createdAt)) &&
        typeof id === "string" &&
        isUuid(id)
      ) {
        return { createdAt, id };
      }
    }
  } catch {
    // fall through
  }
  throw new AppError("VALIDATION_FAILED", "Invalid cursor");
}

/** Page variant: a malformed cursor (e.g. an edited URL) just shows the first page. */
export function decodeCursorOrFirstPage(value: string | undefined): KeysetCursor | undefined {
  try {
    return decodeCursor(value);
  } catch {
    return undefined;
  }
}
