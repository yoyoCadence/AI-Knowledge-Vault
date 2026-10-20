import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Compact HMAC-SHA256 signed tokens: `base64url(json).base64url(mac)`.
 * Used for local-storage signed URLs and preview-origin access (ADR-006, ADR-007).
 *
 * Every token carries a `purpose` (domain separation, so a token minted for one use can
 * never be replayed for another) and an absolute expiry `exp` in epoch seconds.
 */
export interface SignedTokenClaims {
  purpose: string;
  exp: number;
  [claim: string]: unknown;
}

export type VerifyResult<T> =
  | { ok: true; claims: T }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "wrong_purpose" };

function mac(secret: string, data: string): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

export function signToken(secret: string, claims: SignedTokenClaims): string {
  const body = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${body}.${mac(secret, body).toString("base64url")}`;
}

export function verifyToken<T extends SignedTokenClaims>(
  secret: string,
  token: string,
  expectedPurpose: string,
  now: Date = new Date(),
): VerifyResult<T> {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const [body, signature] = parts;

  const expected = mac(secret, body);
  let given: Buffer;
  try {
    given = Buffer.from(signature, "base64url");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "bad_signature" };
  }

  let claims: T;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof claims !== "object" || claims === null || typeof claims.exp !== "number") {
    return { ok: false, reason: "malformed" };
  }
  if (claims.purpose !== expectedPurpose) return { ok: false, reason: "wrong_purpose" };
  if (claims.exp * 1000 <= now.getTime()) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}
