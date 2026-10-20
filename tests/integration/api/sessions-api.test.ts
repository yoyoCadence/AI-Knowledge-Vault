import { afterAll, describe, expect, it } from "vitest";
import { DELETE as deleteSession } from "@/app/api/sessions/[id]/route";
import { POST as revokeOthers } from "@/app/api/sessions/revoke-others/route";
import { GET as listSessions } from "@/app/api/sessions/route";
import { getEnv } from "@/infrastructure/config/env";
import { closeDb } from "@/infrastructure/database/client";
import { newId } from "@/lib/ids";
import { createTestAdmin, signIn } from "../helpers/auth";
import { closeTestDb } from "../helpers/db";

afterAll(async () => {
  await closeDb();
  await closeTestDb();
});

function apiRequest(
  path: string,
  init: { method?: string; cookie?: string; origin?: string | null; body?: string } = {},
) {
  const headers = new Headers({ "content-type": "application/json" });
  const origin = init.origin === undefined ? getEnv().APP_ORIGIN : init.origin;
  if (origin) headers.set("origin", origin);
  if (init.cookie) headers.set("cookie", init.cookie);
  return new Request(`${getEnv().APP_ORIGIN}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body,
  });
}

const params = <T>(value: T) => ({ params: Promise.resolve(value) });

describe("authenticated API routes", () => {
  it("returns 401 with a structured error when no session is present", async () => {
    const response = await listSessions(apiRequest("/api/sessions"), params({}));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "UNAUTHENTICATED", message: "Authentication required" },
    });
  });

  it("lists the actor's sessions with a valid session cookie", async () => {
    const admin = await createTestAdmin();
    const { cookie } = await signIn(admin.email, admin.password);
    const response = await listSessions(apiRequest("/api/sessions", { cookie }), params({}));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { items: { current: boolean }[] };
    expect(body.items.some((item) => item.current)).toBe(true);
  });

  it("rejects cross-origin and origin-less mutations (CSRF)", async () => {
    const admin = await createTestAdmin();
    const { cookie } = await signIn(admin.email, admin.password);

    const foreign = await revokeOthers(
      apiRequest("/api/sessions/revoke-others", {
        method: "POST",
        cookie,
        origin: "https://evil.example",
        body: "{}",
      }),
      params({}),
    );
    expect(foreign.status).toBe(403);
    expect(((await foreign.json()) as { error: { code: string } }).error.code).toBe(
      "CSRF_REJECTED",
    );

    const missing = await revokeOthers(
      apiRequest("/api/sessions/revoke-others", {
        method: "POST",
        cookie,
        origin: null,
        body: "{}",
      }),
      params({}),
    );
    expect(missing.status).toBe(403);
  });

  it("returns 404 for malformed and foreign session ids", async () => {
    const admin = await createTestAdmin();
    const { cookie } = await signIn(admin.email, admin.password);
    const malformed = await deleteSession(
      apiRequest("/api/sessions/x", { method: "DELETE", cookie }),
      params({ id: "not-a-uuid" }),
    );
    expect(malformed.status).toBe(404);
    const unknown = await deleteSession(
      apiRequest(`/api/sessions/${newId()}`, { method: "DELETE", cookie }),
      params({ id: newId() }),
    );
    expect(unknown.status).toBe(404);
  });
});
