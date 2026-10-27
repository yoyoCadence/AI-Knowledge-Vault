import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as shareCheckRoute } from "@/app/api/artifacts/[id]/share-check/route";
import {
  GET as listSharesRoute,
  POST as createShareRoute,
} from "@/app/api/artifacts/[id]/shares/route";
import { PUT as visibilityRoute } from "@/app/api/artifacts/[id]/visibility/route";
import { GET as listArtifactsRoute } from "@/app/api/artifacts/route";
import { DELETE as revokeRoute } from "@/app/api/shares/[id]/route";
import { getEnv } from "@/infrastructure/config/env";
import { closeDb } from "@/infrastructure/database/client";
import { workspaceMembers } from "@/infrastructure/database/schema";
import { newId } from "@/lib/ids";
import { resolveShare } from "@/modules/sharing";
import { htmlDocument } from "@tests/fixtures/builders";
import { createTestAdmin, signInOk } from "../helpers/auth";
import { closeTestDb, testDb } from "../helpers/db";
import { drainJobs, newBatch, uploadFile } from "../helpers/imports";

afterAll(async () => {
  await closeDb();
  await closeTestDb();
});

const env = getEnv();
const params = <T>(value: T) => ({ params: Promise.resolve(value) });

function request(
  path: string,
  init: { method?: string; cookie: string; body?: unknown; origin?: string | null },
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    cookie: init.cookie,
  };
  if (init.origin !== null) headers.origin = init.origin ?? env.APP_ORIGIN;
  return new Request(`${env.APP_ORIGIN}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function loggedIn() {
  const admin = await createTestAdmin();
  const { cookie } = await signInOk(admin.email, admin.password);
  const actor = {
    userId: admin.userId,
    workspaceId: admin.workspaceId,
    role: "owner" as const,
    sessionId: newId(),
    email: admin.email,
    name: "Owner",
  };
  return { ...admin, cookie, actor };
}

interface ShareJson {
  id: string;
  active: boolean;
  allowDownload: boolean;
  expiresAt: string | null;
  label: string | null;
}

const OPTIONS = {
  allowPreview: true,
  allowReading: true,
  allowDownload: false,
  acknowledgeFindings: true,
};

describe("sharing API (API_CONTRACT §8)", () => {
  let owner: Awaited<ReturnType<typeof loggedIn>>;
  let artifactId: string;

  beforeAll(async () => {
    owner = await loggedIn();
    await uploadFile(owner.actor, (await newBatch(owner.actor)).id, {
      filename: "share-api.html",
      bytes: htmlDocument({ title: "分享 API", body: "<p>聯絡 bob@example.com</p>" }),
    });
    await drainJobs();
    const listed = (await (
      await listArtifactsRoute(request("/api/artifacts", { cookie: owner.cookie }), params({}))
    ).json()) as { items: { id: string }[] };
    artifactId = listed.items[0]!.id;
  });

  const check = (cookie = owner.cookie) =>
    shareCheckRoute(
      request(`/api/artifacts/${artifactId}/share-check`, { method: "POST", cookie }),
      params({ id: artifactId }),
    );
  const create = (body: unknown, cookie = owner.cookie, origin?: string | null) =>
    createShareRoute(
      request(`/api/artifacts/${artifactId}/shares`, { method: "POST", cookie, body, origin }),
      params({ id: artifactId }),
    );
  const list = (cookie = owner.cookie) =>
    listSharesRoute(
      request(`/api/artifacts/${artifactId}/shares`, { cookie }),
      params({ id: artifactId }),
    );
  const revoke = (id: string, cookie = owner.cookie) =>
    revokeRoute(request(`/api/shares/${id}`, { method: "DELETE", cookie }), params({ id }));
  const visibility = (body: unknown, cookie = owner.cookie) =>
    visibilityRoute(
      request(`/api/artifacts/${artifactId}/visibility`, { method: "PUT", cookie, body }),
      params({ id: artifactId }),
    );

  it("checks, creates (URL once), lists without tokens, and revokes", async () => {
    const checked = await check();
    expect(checked.status).toBe(200);
    expect(await checked.json()).toMatchObject({
      blocked: false,
      visibility: "private",
      findings: [{ kind: "email", count: 1 }],
    });

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const created = await create({ ...OPTIONS, label: "審稿", expiresAt });
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const body = (await created.json()) as { share: ShareJson; url: string; madeUnlisted: boolean };
    expect(body.madeUnlisted).toBe(true);
    expect(body.share).toMatchObject({ label: "審稿", active: true, expiresAt });
    const match = /^(.+)\/s\/([A-Za-z0-9_-]{43})$/.exec(body.url);
    expect(match?.[1]).toBe(env.APP_ORIGIN);
    expect(await resolveShare(testDb(), match![2]!)).not.toBeNull();

    const listedText = await (await list()).text();
    expect(listedText).not.toContain(match![2]!);
    expect(listedText).not.toContain("token");
    const listed = JSON.parse(listedText) as { items: ShareJson[] };
    expect(listed.items.map((item) => item.id)).toContain(body.share.id);

    expect(await (await revoke(body.share.id)).json()).toEqual({ revoked: true });
    expect((await revoke(body.share.id)).status).toBe(200);
    expect(await resolveShare(testDb(), match![2]!)).toBeNull();
    expect((await revoke(newId())).status).toBe(404);
    expect((await revoke("not-a-uuid")).status).toBe(404);
  });

  it("requires the acknowledgement and valid options", async () => {
    const { acknowledgeFindings: _ack, ...unacknowledged } = OPTIONS;
    for (const bad of [
      unacknowledged,
      { ...OPTIONS, acknowledgeFindings: false },
      { ...OPTIONS, allowPreview: false, allowReading: false },
      { ...OPTIONS, expiresAt: "2020-01-01T00:00:00Z" },
      { ...OPTIONS, expiresAt: "tomorrow" },
      { ...OPTIONS, token: "mine" },
      { ...OPTIONS, allowDownload: "yes" },
      { ...OPTIONS, expiresInDays: 0 },
      { ...OPTIONS, expiresInDays: 366 },
      { ...OPTIONS, expiresInDays: "7" },
      { ...OPTIONS, expiresInDays: 7, expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
    ]) {
      expect((await create(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    const yearLong = await create({ ...OPTIONS, expiresInDays: 365 });
    expect(yearLong.status).toBe(201);
    const { share } = (await yearLong.json()) as { share: ShareJson };
    const days = (new Date(share.expiresAt!).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(364.99);
    expect(days).toBeLessThanOrEqual(365);
    expect((await create(OPTIONS, owner.cookie, null)).status).toBe(403);
    expect((await create(OPTIONS, owner.cookie, "https://evil.example")).status).toBe(403);
  });

  it("makes the artifact private again, revoking every link", async () => {
    const first = (await (await create(OPTIONS)).json()) as { url: string };
    await create(OPTIONS);
    const changed = await visibility({ visibility: "private" });
    expect(await changed.json()).toMatchObject({ visibility: "private" });
    expect(await resolveShare(testDb(), first.url.split("/s/")[1]!)).toBeNull();
    const listed = (await (await list()).json()) as { items: ShareJson[] };
    expect(listed.items.every((item) => !item.active)).toBe(true);
    for (const bad of [{ visibility: "public" }, { visibility: "secret" }, {}]) {
      expect((await visibility(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(await (await visibility({ visibility: "unlisted" })).json()).toEqual({
      visibility: "unlisted",
      revoked: 0,
    });
  });

  it("is for members who manage shares, within their workspace", async () => {
    const stranger = await loggedIn();
    expect((await check(stranger.cookie)).status).toBe(404);
    expect((await create(OPTIONS, stranger.cookie)).status).toBe(404);
    expect((await list(stranger.cookie)).status).toBe(404);
    expect((await visibility({ visibility: "private" }, stranger.cookie)).status).toBe(404);
    const someLink = (await (await create(OPTIONS)).json()) as { share: ShareJson };
    expect((await revoke(someLink.share.id, stranger.cookie)).status).toBe(404);

    const viewer = await loggedIn();
    await testDb()
      .update(workspaceMembers)
      .set({ workspaceId: owner.workspaceId, role: "viewer" })
      .where(eq(workspaceMembers.userId, viewer.userId));
    expect((await check(viewer.cookie)).status).toBe(403);
    expect((await create(OPTIONS, viewer.cookie)).status).toBe(403);
    expect((await list(viewer.cookie)).status).toBe(403);
    expect((await revoke(someLink.share.id, viewer.cookie)).status).toBe(403);
    expect((await visibility({ visibility: "private" }, viewer.cookie)).status).toBe(403);
    expect((await list("")).status).toBe(401);
  });
});
