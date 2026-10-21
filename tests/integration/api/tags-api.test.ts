import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as getArtifact } from "@/app/api/artifacts/[id]/route";
import { DELETE as untagRoute, PUT as tagRoute } from "@/app/api/artifacts/[id]/tags/[tagId]/route";
import { GET as listArtifactsRoute } from "@/app/api/artifacts/route";
import { GET as searchRoute } from "@/app/api/search/route";
import { POST as mergeRoute } from "@/app/api/tags/[id]/merge/route";
import { DELETE as deleteTagRoute, PATCH as renameRoute } from "@/app/api/tags/[id]/route";
import { GET as listTagsRoute, POST as createTagRoute } from "@/app/api/tags/route";
import { getEnv } from "@/infrastructure/config/env";
import { closeDb } from "@/infrastructure/database/client";
import { workspaceMembers } from "@/infrastructure/database/schema";
import { newId } from "@/lib/ids";
import { htmlDocument } from "@tests/fixtures/builders";
import { createTestAdmin, signInOk } from "../helpers/auth";
import { closeTestDb, testDb } from "../helpers/db";
import { drainJobs, newBatch, uploadFile } from "../helpers/imports";

afterAll(async () => {
  await closeDb();
  await closeTestDb();
});

type Tag = { id: string; name: string };
const params = <T>(value: T) => ({ params: Promise.resolve(value) });

function request(
  path: string,
  init: { method?: string; cookie: string; body?: unknown; origin?: string | null },
) {
  const headers = new Headers({ "content-type": "application/json", cookie: init.cookie });
  if (init.origin !== null) headers.set("origin", init.origin ?? getEnv().APP_ORIGIN);
  return new Request(`${getEnv().APP_ORIGIN}${path}`, {
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

describe("tag API (API_CONTRACT §6)", () => {
  let owner: Awaited<ReturnType<typeof loggedIn>>;
  let artifactId: string;

  beforeAll(async () => {
    owner = await loggedIn();
    const item = await uploadFile(owner.actor, (await newBatch(owner.actor)).id, {
      filename: "tag-api.html",
      bytes: htmlDocument({ title: "標籤 API 測試", body: "<p>雨水花園。</p>" }),
    });
    await drainJobs();
    const listed = (await (
      await listArtifactsRoute(request("/api/artifacts", { cookie: owner.cookie }), params({}))
    ).json()) as { items: { id: string; title: string }[] };
    artifactId = listed.items.find((item) => item.title === "標籤 API 測試")!.id;
    expect(item.batchId).toBeTruthy();
  });

  const create = (name: unknown, cookie = owner.cookie) =>
    createTagRoute(request("/api/tags", { method: "POST", cookie, body: { name } }), params({}));
  const tag = (method: "PUT" | "DELETE", tagId: string, cookie = owner.cookie, id = artifactId) =>
    (method === "PUT" ? tagRoute : untagRoute)(
      request(`/api/artifacts/${id}/tags/${tagId}`, { method, cookie }),
      params({ id, tagId }),
    );

  it("creates (201) or returns the existing tag (200), and lists tags with counts", async () => {
    const first = await create("海綿城市");
    expect(first.status).toBe(201);
    const { tag: created } = (await first.json()) as { tag: Tag };
    const again = await create(" 海綿城市 ");
    expect(again.status).toBe(200);
    expect(((await again.json()) as { tag: Tag }).tag).toEqual(created);

    expect((await tag("PUT", created.id)).status).toBe(200);
    const list = (await (
      await listTagsRoute(request("/api/tags", { cookie: owner.cookie }), params({}))
    ).json()) as { items: (Tag & { artifactCount: number })[] };
    expect(list.items).toContainEqual({ ...created, artifactCount: 1 });

    expect((await create("")).status).toBe(400);
    expect((await create(42)).status).toBe(400);
  });

  it("tags and untags artifacts; detail, list and search reflect it", async () => {
    const { tag: created } = (await (await create("雨水回收")).json()) as { tag: Tag };
    const put = await tag("PUT", created.id);
    expect(put.status).toBe(200);
    expect(((await put.json()) as { tags: Tag[] }).tags).toContainEqual(created);

    const detail = (await (
      await getArtifact(
        request(`/api/artifacts/${artifactId}`, { cookie: owner.cookie }),
        params({ id: artifactId }),
      )
    ).json()) as { artifact: { tags: Tag[] } };
    expect(detail.artifact.tags).toContainEqual(created);

    const filtered = (await (
      await listArtifactsRoute(
        request(`/api/artifacts?tag=${created.id}`, { cookie: owner.cookie }),
        params({}),
      )
    ).json()) as { items: { id: string }[] };
    expect(filtered.items.map((item) => item.id)).toEqual([artifactId]);
    const searched = (await (
      await searchRoute(
        request(`/api/search?q=${encodeURIComponent("雨水")}&tag=${created.id}`, {
          cookie: owner.cookie,
        }),
        params({}),
      )
    ).json()) as { items: { id: string }[] };
    expect(searched.items.map((item) => item.id)).toEqual([artifactId]);

    const removed = await tag("DELETE", created.id);
    expect(((await removed.json()) as { tags: Tag[] }).tags).not.toContainEqual(created);

    expect(
      (
        await listArtifactsRoute(
          request("/api/artifacts?tag=nope", { cookie: owner.cookie }),
          params({}),
        )
      ).status,
    ).toBe(400);
  });

  it("renames (409 on a taken name), merges and deletes", async () => {
    const { tag: a } = (await (await create("甲標籤")).json()) as { tag: Tag };
    const { tag: b } = (await (await create("乙標籤")).json()) as { tag: Tag };
    const rename = (id: string, name: string) =>
      renameRoute(
        request(`/api/tags/${id}`, { method: "PATCH", cookie: owner.cookie, body: { name } }),
        params({ id }),
      );
    const renamed = await rename(a.id, "丙標籤");
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { tag: Tag }).tag).toEqual({ id: a.id, name: "丙標籤" });
    const conflict = await rename(a.id, "乙標籤");
    expect(conflict.status).toBe(409);
    expect(
      ((await conflict.json()) as { error: { details: { tagId: string } } }).error.details,
    ).toEqual({
      tagId: b.id,
    });
    expect((await rename("not-a-uuid", "x")).status).toBe(404);

    await tag("PUT", a.id);
    const merged = await mergeRoute(
      request(`/api/tags/${a.id}/merge`, {
        method: "POST",
        cookie: owner.cookie,
        body: { intoTagId: b.id },
      }),
      params({ id: a.id }),
    );
    expect(merged.status).toBe(200);
    expect(((await merged.json()) as { tag: Tag }).tag).toEqual(b);
    expect((await tag("PUT", a.id)).status).toBe(404);

    const deleted = await deleteTagRoute(
      request(`/api/tags/${b.id}`, { method: "DELETE", cookie: owner.cookie }),
      params({ id: b.id }),
    );
    expect(deleted.status).toBe(200);
    expect((await tag("DELETE", b.id)).status).toBe(404);
  });

  it("is invisible to other workspaces and read-only for viewers", async () => {
    const { tag: mine } = (await (await create("只屬於我")).json()) as { tag: Tag };
    const stranger = await loggedIn();
    expect((await tag("PUT", mine.id, stranger.cookie)).status).toBe(404);
    const { tag: theirs } = (await (await create("他們的", stranger.cookie)).json()) as {
      tag: Tag;
    };
    expect((await tag("PUT", theirs.id, stranger.cookie)).status).toBe(404);
    expect((await tag("PUT", theirs.id)).status).toBe(404);
    const strangerRename = await renameRoute(
      request(`/api/tags/${mine.id}`, {
        method: "PATCH",
        cookie: stranger.cookie,
        body: { name: "偷改" },
      }),
      params({ id: mine.id }),
    );
    expect(strangerRename.status).toBe(404);

    const viewer = await loggedIn();
    await testDb()
      .update(workspaceMembers)
      .set({ role: "viewer" })
      .where(eq(workspaceMembers.userId, viewer.userId));
    expect((await create("檢視者", viewer.cookie)).status).toBe(403);
    expect(
      (await listTagsRoute(request("/api/tags", { cookie: viewer.cookie }), params({}))).status,
    ).toBe(200);
  });

  it("refuses cross-site writes (CSRF)", async () => {
    const crossSite = await createTagRoute(
      request("/api/tags", {
        method: "POST",
        cookie: owner.cookie,
        body: { name: "跨站" },
        origin: "https://evil.example",
      }),
      params({}),
    );
    expect(crossSite.status).toBe(403);
  });
});
