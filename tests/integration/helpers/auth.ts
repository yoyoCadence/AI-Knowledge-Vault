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

let ipCounter = 0;
/** Unique client IP per call site so rate-limit buckets never collide across tests. */
export function uniqueIp(): string {
  ipCounter += 1;
  return `10.${Math.floor(ipCounter / 250) % 250}.${ipCounter % 250}.${(Date.now() % 200) + 1}`;
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

export async function actorFromCookie(cookie: string) {
  return resolveActor(testAuth(), testDb(), new Headers({ cookie }));
}
