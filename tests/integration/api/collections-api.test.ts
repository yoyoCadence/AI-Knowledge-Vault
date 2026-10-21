import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as getArtifact } from "@/app/api/artifacts/[id]/route";
import { GET as listArtifactsRoute } from "@/app/api/artifacts/route";
import {
  DELETE as deleteItemRoute,
  PUT as putItemRoute,
} from "@/app/api/collections/[id]/items/[artifactId]/route";
import {
  DELETE as deleteCollectionRoute,
  PATCH as patchCollectionRoute,
} from "@/app/api/collections/[id]/route";
import {
  GET as listCollectionsRoute,
  POST as createCollectionRoute,
} from "@/app/api/collections/route";
import { POST as createImportRoute } from "@/app/api/imports/route";
import { GET as searchRoute } from "@/app/api/search/route";
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

type Collection = { id: string; parentId: string | null; kind: string; name: string };
type Paths = { collections: { id: string; name: string; path: string[] }[] };
const params = <T>(value: T) => ({ params: Promise.resolve(value) });

function request(path: string, init: { method?: string; cookie: string; body?: unknown }) {
  return new Request(`${getEnv().APP_ORIGIN}${path}`, {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/json",
      cookie: init.cookie,
      origin: getEnv().APP_ORIGIN,
    },
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

describe("collections API (API_CONTRACT §6)", () => {
  let owner: Awaited<ReturnType<typeof loggedIn>>;
  let artifactId: string;

  beforeAll(async () => {
    owner = await loggedIn();
    await uploadFile(owner.actor, (await newBatch(owner.actor)).id, {
      filename: "collections-api.html",
      bytes: htmlDocument({ title: "集合 API 測試", body: "<p>雨水花園的設計。</p>" }),
    });
    await drainJobs();
    const listed = (await (
      await listArtifactsRoute(request("/api/artifacts", { cookie: owner.cookie }), params({}))
    ).json()) as { items: { id: string }[] };
    artifactId = listed.items[0]!.id;
  });

  const create = (body: unknown, cookie = owner.cookie) =>
    createCollectionRoute(
      request("/api/collections", { method: "POST", cookie, body }),
      params({}),
    );
  const patch = (id: string, body: unknown, cookie = owner.cookie) =>
    patchCollectionRoute(
      request(`/api/collections/${id}`, { method: "PATCH", cookie, body }),
      params({ id }),
    );
  const remove = (id: string, cookie = owner.cookie) =>
    deleteCollectionRoute(
      request(`/api/collections/${id}`, { method: "DELETE", cookie }),
      params({ id }),
    );
  const item = (method: "PUT" | "DELETE", id: string, artifact: string, cookie = owner.cookie) =>
    (method === "PUT" ? putItemRoute : deleteItemRoute)(
      request(`/api/collections/${id}/items/${artifact}`, { method, cookie }),
      params({ id, artifactId: artifact }),
    );
  const created = async (body: unknown) =>
    ((await (await create(body)).json()) as { collection: Collection }).collection;

  it("creates, lists, renames, moves and deletes collections", async () => {
    const response = await create({ name: "  景觀  ", kind: "category" });
    expect(response.status).toBe(201);
    const top = ((await response.json()) as { collection: Collection }).collection;
    expect(top).toMatchObject({ name: "景觀", kind: "category", parentId: null });
    const child = await created({ name: "雨水花園", parentId: top.id });

    const tree = (await (
      await listCollectionsRoute(request("/api/collections", { cookie: owner.cookie }), params({}))
    ).json()) as { items: (Collection & { depth: number })[] };
    expect(tree.items.map((row) => [row.name, row.depth])).toEqual([
      ["景觀", 0],
      ["雨水花園", 1],
    ]);

    expect((await create({ name: "雨水花園", parentId: top.id })).status).toBe(409);
    expect((await create({ name: "x", parentId: newId() })).status).toBe(404);
    expect((await create({ name: "" })).status).toBe(400);
    expect((await create({ name: "x", kind: "folder" })).status).toBe(400);
    expect((await create({ name: "x", color: "red" })).status).toBe(400); // strict

    const renamed = await patch(child.id, { name: "雨庭", kind: "category" });
    expect(((await renamed.json()) as { collection: Collection }).collection).toMatchObject({
      name: "雨庭",
      kind: "category",
    });
    expect((await patch(top.id, { parentId: child.id })).status).toBe(400); // cycle
    expect((await patch(top.id, {})).status).toBe(400);
    expect((await patch("not-a-uuid", { name: "x" })).status).toBe(404);

    const blocked = await remove(top.id);
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({
      error: { code: "CONFLICT", details: { reason: "HAS_CHILDREN" } },
    });
    const moved = await patch(child.id, { parentId: null });
    expect(((await moved.json()) as { collection: Collection }).collection.parentId).toBeNull();
    expect((await remove(top.id)).status).toBe(200);
    expect((await remove(top.id)).status).toBe(404);
  });

  it("puts artifacts in collections; the artifact, library and search follow", async () => {
    const top = await created({ name: "水文", kind: "category" });
    const child = await created({ name: "滯洪", parentId: top.id });

    const put = await item("PUT", child.id, artifactId);
    expect(put.status).toBe(200);
    expect(((await put.json()) as Paths).collections).toEqual([
      { id: child.id, name: "滯洪", path: ["水文", "滯洪"] },
    ]);
    const detail = (await (
      await getArtifact(
        request(`/api/artifacts/${artifactId}`, { cookie: owner.cookie }),
        params({ id: artifactId }),
      )
    ).json()) as { artifact: Paths };
    expect(detail.artifact.collections.map((row) => row.id)).toEqual([child.id]);

    const byCollection = (await (
      await listArtifactsRoute(
        request(`/api/artifacts?collection=${top.id}`, { cookie: owner.cookie }),
        params({}),
      )
    ).json()) as { items: { id: string }[] };
    expect(byCollection.items.map((row) => row.id)).toEqual([artifactId]);
    const searched = (await (
      await searchRoute(
        request(`/api/search?q=${encodeURIComponent("雨水花園")}&collection=${top.id}`, {
          cookie: owner.cookie,
        }),
        params({}),
      )
    ).json()) as { items: { id: string }[] };
    expect(searched.items.map((row) => row.id)).toEqual([artifactId]);
    expect(
      (
        await listArtifactsRoute(
          request("/api/artifacts?collection=x", { cookie: owner.cookie }),
          params({}),
        )
      ).status,
    ).toBe(400);

    const removed = await item("DELETE", child.id, artifactId);
    expect(((await removed.json()) as Paths).collections).toEqual([]);
    expect((await item("PUT", newId(), artifactId)).status).toBe(404);
    expect((await item("PUT", child.id, newId())).status).toBe(404);
  });

  it("imports straight into a collection", async () => {
    const inbox = await created({ name: "收件匣" });
    const response = await createImportRoute(
      request("/api/imports", {
        method: "POST",
        cookie: owner.cookie,
        body: { collectionId: inbox.id },
      }),
      params({}),
    );
    expect(response.status).toBe(201);
    const { batch } = (await response.json()) as {
      batch: { id: string; targetCollectionId: string };
    };
    expect(batch.targetCollectionId).toBe(inbox.id);
    expect(
      (
        await createImportRoute(
          request("/api/imports", {
            method: "POST",
            cookie: owner.cookie,
            body: { collectionId: newId() },
          }),
          params({}),
        )
      ).status,
    ).toBe(404);
  });

  it("is invisible to other workspaces and read-only for viewers", async () => {
    const mine = await created({ name: "私人分類" });
    const stranger = await loggedIn();
    expect((await patch(mine.id, { name: "偷改" }, stranger.cookie)).status).toBe(404);
    expect((await remove(mine.id, stranger.cookie)).status).toBe(404);
    expect((await item("PUT", mine.id, artifactId, stranger.cookie)).status).toBe(404);
    expect((await create({ name: "掛上去", parentId: mine.id }, stranger.cookie)).status).toBe(404);
    const theirs = (await (await create({ name: "他們的" }, stranger.cookie)).json()) as {
      collection: Collection;
    };
    expect((await item("PUT", theirs.collection.id, artifactId)).status).toBe(404);
    // Filtering by another workspace's collection shows nothing, as for a missing one.
    await item("PUT", mine.id, artifactId);
    const filtered = (await (
      await listArtifactsRoute(
        request(`/api/artifacts?collection=${mine.id}`, { cookie: stranger.cookie }),
        params({}),
      )
    ).json()) as { items: unknown[] };
    expect(filtered.items).toEqual([]);
    const searched = (await (
      await searchRoute(
        request(`/api/search?q=${encodeURIComponent("雨水花園")}&collection=${mine.id}`, {
          cookie: stranger.cookie,
        }),
        params({}),
      )
    ).json()) as { items: unknown[] };
    expect(searched.items).toEqual([]);
    const theirList = (await (
      await listCollectionsRoute(
        request("/api/collections", { cookie: stranger.cookie }),
        params({}),
      )
    ).json()) as { items: Collection[] };
    expect(theirList.items.map((row) => row.id)).toEqual([theirs.collection.id]);

    const viewer = await loggedIn();
    await testDb()
      .update(workspaceMembers)
      .set({ role: "viewer" })
      .where(eq(workspaceMembers.userId, viewer.userId));
    expect((await create({ name: "檢視者" }, viewer.cookie)).status).toBe(403);
    expect(
      (
        await listCollectionsRoute(
          request("/api/collections", { cookie: viewer.cookie }),
          params({}),
        )
      ).status,
    ).toBe(200);
  });
});
