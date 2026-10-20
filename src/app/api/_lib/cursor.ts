import { AppError } from "@/lib/errors";
import { isUuid } from "@/lib/ids";

/** Opaque keyset cursor `(createdAt, id)` for newest-first listings (docs/API_CONTRACT.md §1). */
export interface KeysetCursor {
  createdAt: Date;
  id: string;
}

export function encodeCursor(cursor: KeysetCursor | null): string | null {
  if (!cursor) return null;
  return Buffer.from(JSON.stringify([cursor.createdAt.toISOString(), cursor.id])).toString(
    "base64url",
  );
}

export function decodeCursor(cursor: string | undefined): KeysetCursor | undefined {
  if (!cursor) return undefined;
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as [
      unknown,
      unknown,
    ];
    const date = new Date(String(createdAt));
    if (typeof id === "string" && isUuid(id) && !Number.isNaN(date.getTime())) {
      return { createdAt: date, id };
    }
  } catch {
    // fall through
  }
  throw new AppError("VALIDATION_FAILED", "Invalid cursor");
}
