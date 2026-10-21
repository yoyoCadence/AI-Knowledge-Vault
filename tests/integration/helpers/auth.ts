import { randomBytes } from "node:crypto";
import { getEnv } from "@/infrastructure/config/env";
import { createAuth, createAdmin, resolveActor, type Auth } from "@/modules/auth";
import { newId } from "@/lib/ids";
import { testDb } from "./db";

let shared: Auth | undefined;

export function testAuth(): Auth {
  shared ??= createAuth(testDb(), getEnv());
  return shared;
}

export const TEST_PASSWORD = "correct horse battery staple";

/** Creates an admin (user + workspace + owner membership) with a unique email. */
export async function createTestAdmin(password = TEST_PASSWORD) {
  const email = `admin-${newId().slice(-12)}@example.test`;
  const created = await createAdmin(testDb(), { email, name: "Test Admin", password });
  return { ...created, email, password };
}

/**
 * A random private client IP, so rate-limit buckets never collide across tests. The buckets
 * live in the database for the whole run, so a per-file counter is not enough: it restarts
 * in every test file, and a file's 4th sign-in could land in the bucket that auth.test.ts
 * deliberately exhausted, failing with 429 (seen as a stray 401 in imports-api.test.ts).
 */
export function uniqueIp(): string {
  const [a, b, c] = randomBytes(3);
  return `10.${a}.${b}.${(c! % 254) + 1}`;
}

export function authRequest(
  path: string,
  init: { method?: string; body?: unknown; cookie?: string; ip?: string } = {},
) {
  const origin = getEnv().APP_ORIGIN;
  const headers = new Headers({
    origin,
    "content-type": "application/json",
    "user-agent": "vitest",
  });
  if (init.cookie) headers.set("cookie", init.cookie);
  headers.set("x-forwarded-for", init.ip ?? uniqueIp());
  return new Request(`${origin}/api/auth${path}`, {
    method: init.method ?? "POST",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

/** Extracts `name=value` pairs from Set-Cookie headers into a Cookie header value. */
export function cookieHeaderFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

export async function signIn(email: string, password: string, ip?: string) {
  const response = await testAuth().handler(
    authRequest("/sign-in/email", { body: { email, password }, ip }),
  );
  return { response, cookie: cookieHeaderFrom(response) };
}

/** Signs in and fails loudly (status and body) unless it succeeded, for tests that need a session. */
export async function signInOk(email: string, password: string, ip?: string) {
  const result = await signIn(email, password, ip);
  if (result.response.status !== 200) {
    throw new Error(
      `sign-in failed: ${result.response.status} ${await result.response.clone().text()}`,
    );
  }
  return result;
}

export async function actorFromCookie(cookie: string) {
  return resolveActor(testAuth(), testDb(), new Headers({ cookie }));
}
