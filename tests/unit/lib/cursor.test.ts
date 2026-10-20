import { describe, expect, it } from "vitest";
import { decodeCursor, decodeCursorOrFirstPage, encodeCursor } from "@/lib/cursor";
import { AppError } from "@/lib/errors";

const id = "01a1594a-57ce-77a0-9d5c-6564685effdb";
const raw = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

describe("keyset cursor codec", () => {
  it("round-trips microsecond timestamps exactly", () => {
    const cursor = { createdAt: "2026-10-20T12:00:00.123456Z", id };
    expect(decodeCursor(encodeCursor(cursor)!)).toEqual(cursor);
    expect(encodeCursor(null)).toBeNull();
    expect(decodeCursor(undefined)).toBeUndefined();
  });

  it("rejects malformed cursors with VALIDATION_FAILED instead of reaching SQL", () => {
    for (const bad of [
      "not-base64-json",
      raw(["x", "y"]),
      raw(["2026-10-20T12:00:00Z", "not-a-uuid"]),
      raw(["2026-13-45T99:00:00Z", id]),
      raw({ createdAt: "2026-10-20T12:00:00Z", id }),
      raw(["2026-10-20 12:00:00", id]),
    ]) {
      expect(() => decodeCursor(bad), bad).toThrow(AppError);
    }
  });

  it("page variant falls back to the first page", () => {
    expect(decodeCursorOrFirstPage(raw(["x", "y"]))).toBeUndefined();
  });
});
