import { describe, expect, it } from "vitest";
import { signToken, verifyToken } from "@/lib/signed-token";

const secret = "x".repeat(48);

describe("signed tokens", () => {
  const future = Math.floor(Date.now() / 1000) + 60;

  it("round-trips claims", () => {
    const token = signToken(secret, { purpose: "p", exp: future, key: "k" });
    const result = verifyToken<{ purpose: string; exp: number; key: string }>(secret, token, "p");
    expect(result).toEqual({ ok: true, claims: { purpose: "p", exp: future, key: "k" } });
  });

  it("rejects tampered payloads and signatures", () => {
    const token = signToken(secret, { purpose: "p", exp: future, key: "k" });
    const [body, sig] = token.split(".") as [string, string];
    const forgedBody = Buffer.from(
      JSON.stringify({ purpose: "p", exp: future, key: "other" }),
    ).toString("base64url");
    expect(verifyToken(secret, `${forgedBody}.${sig}`, "p")).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(verifyToken(secret, `${body}.${sig.slice(0, -2)}AA`, "p").ok).toBe(false);
    expect(verifyToken("y".repeat(48), token, "p")).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("enforces purpose separation and expiry", () => {
    const token = signToken(secret, { purpose: "upload", exp: future });
    expect(verifyToken(secret, token, "download")).toEqual({ ok: false, reason: "wrong_purpose" });
    const expired = signToken(secret, {
      purpose: "upload",
      exp: Math.floor(Date.now() / 1000) - 1,
    });
    expect(verifyToken(secret, expired, "upload")).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects malformed tokens", () => {
    expect(verifyToken(secret, "", "p").ok).toBe(false);
    expect(verifyToken(secret, "abc", "p").ok).toBe(false);
    expect(verifyToken(secret, "a.b.c", "p").ok).toBe(false);
  });
});
