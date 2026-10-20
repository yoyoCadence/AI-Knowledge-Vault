import { describe, expect, it } from "vitest";
import { assertSafeStorageKey, storageKeys } from "@/infrastructure/storage/keys";
import { newId } from "@/lib/ids";

describe("storage keys", () => {
  const ws = newId();
  const sha = "a".repeat(64);

  it("builds workspace-scoped, content-addressed original keys", () => {
    expect(storageKeys.original(ws, sha)).toBe(`ws/${ws}/originals/${sha}`);
  });

  it("rejects non-UUID ids and non-hex hashes", () => {
    expect(() => storageKeys.original("../../etc", sha)).toThrow();
    expect(() => storageKeys.original(ws, "../" + "a".repeat(61))).toThrow();
    expect(() => storageKeys.staging(ws, "not-a-uuid")).toThrow();
  });

  it.each(["", "/abs/path", "a/../b", "a/./b", "a//b", "a\\b", "a\u0000b", "x".repeat(1025)])(
    "assertSafeStorageKey rejects %j",
    (key) => {
      expect(() => assertSafeStorageKey(key)).toThrow();
    },
  );

  it("assertSafeStorageKey accepts normal keys including unicode", () => {
    expect(() => assertSafeStorageKey(`ws/${ws}/derived/${ws}/${ws}`)).not.toThrow();
    expect(() => assertSafeStorageKey("health/probe-形態")).not.toThrow();
  });
});
