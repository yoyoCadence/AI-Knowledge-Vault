import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GET as listNotesRoute,
  POST as createNoteRoute,
} from "@/app/api/artifacts/[id]/notes/route";
import {
  GET as getStateRoute,
  PUT as putStateRoute,
} from "@/app/api/artifacts/[id]/reading-state/route";
import { GET as getArtifact } from "@/app/api/artifacts/[id]/route";
import { GET as listArtifactsRoute } from "@/app/api/artifacts/route";
import { DELETE as deleteNoteRoute, PATCH as patchNoteRoute } from "@/app/api/notes/[id]/route";
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

type Note = { id: string; bodyMarkdown: string; authorName: string | null };
type State = { status: string; isFavorite: boolean; lastOpenedAt: string | null };
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

describe("notes and reading-state API (API_CONTRACT §6)", () => {
  let owner: Awaited<ReturnType<typeof loggedIn>>;
  let artifactId: string;

  beforeAll(async () => {
    owner = await loggedIn();
    await uploadFile(owner.actor, (await newBatch(owner.actor)).id, {
      filename: "notes-api.html",
      bytes: htmlDocument({ title: "筆記 API 測試", body: "<p>濕地的鳥類調查。</p>" }),
    });
    await drainJobs();
    const listed = (await (
      await listArtifactsRoute(request("/api/artifacts", { cookie: owner.cookie }), params({}))
    ).json()) as { items: { id: string }[] };
    artifactId = listed.items[0]!.id;
  });

  const create = (body: unknown, cookie = owner.cookie, id = artifactId) =>
    createNoteRoute(
      request(`/api/artifacts/${id}/notes`, { method: "POST", cookie, body }),
      params({ id }),
    );
  const list = (cookie = owner.cookie) =>
    listNotesRoute(
      request(`/api/artifacts/${artifactId}/notes`, { cookie }),
      params({ id: artifactId }),
    );
  const patch = (id: string, body: unknown, cookie = owner.cookie) =>
    patchNoteRoute(request(`/api/notes/${id}`, { method: "PATCH", cookie, body }), params({ id }));
  const remove = (id: string, cookie = owner.cookie) =>
    deleteNoteRoute(request(`/api/notes/${id}`, { method: "DELETE", cookie }), params({ id }));
  const putState = (body: unknown, cookie = owner.cookie) =>
    putStateRoute(
      request(`/api/artifacts/${artifactId}/reading-state`, { method: "PUT", cookie, body }),
      params({ id: artifactId }),
    );

  it("creates, lists, edits and deletes notes", async () => {
    const created = await create({ bodyMarkdown: "**候鳥**過境紀錄" });
    expect(created.status).toBe(201);
    const { note } = (await created.json()) as { note: Note };
    expect(note).toMatchObject({ bodyMarkdown: "**候鳥**過境紀錄" });
    expect(((await (await list()).json()) as { items: Note[] }).items.map((n) => n.id)).toEqual([
      note.id,
    ]);
    const searched = (await (
      await searchRoute(
        request(`/api/search?q=${encodeURIComponent("候鳥")}`, { cookie: owner.cookie }),
        params({}),
      )
    ).json()) as { items: { id: string }[] };
    expect(searched.items.map((item) => item.id)).toEqual([artifactId]);

    const edited = await patch(note.id, { bodyMarkdown: "留鳥" });
    expect(((await edited.json()) as { note: Note }).note.bodyMarkdown).toBe("留鳥");
    expect((await remove(note.id)).status).toBe(200);
    expect((await remove(note.id)).status).toBe(404);

    expect((await create({ bodyMarkdown: "" })).status).toBe(400);
    expect((await create({ bodyMarkdown: "x".repeat(20_001) })).status).toBe(400);
    expect((await create({ bodyMarkdown: "ok", pinned: true })).status).toBe(400); // strict
    expect((await create({ bodyMarkdown: "ok" }, owner.cookie, newId())).status).toBe(404);
    expect((await patch("not-a-uuid", { bodyMarkdown: "x" })).status).toBe(404);
  });

  it("keeps each user's reading state; filters and the artifact follow", async () => {
    const opened = await putState({ opened: true });
    expect(((await opened.json()) as { readingState: State }).readingState).toMatchObject({
      status: "reading",
      isFavorite: false,
    });
    await putState({ isFavorite: true, status: "read" });
    const state = (await (
      await getStateRoute(
        request(`/api/artifacts/${artifactId}/reading-state`, { cookie: owner.cookie }),
        params({ id: artifactId }),
      )
    ).json()) as { readingState: State };
    expect(state.readingState).toMatchObject({ status: "read", isFavorite: true });
    expect(state.readingState.lastOpenedAt).not.toBeNull();

    const detail = (await (
      await getArtifact(
        request(`/api/artifacts/${artifactId}`, { cookie: owner.cookie }),
        params({ id: artifactId }),
      )
    ).json()) as { artifact: { readingState: State } };
    expect(detail.artifact.readingState).toMatchObject({ status: "read", isFavorite: true });

    for (const query of ["favorite=1", "status=read", "sort=opened", "favorite=true&status=read"]) {
      const listed = (await (
        await listArtifactsRoute(
          request(`/api/artifacts?${query}`, { cookie: owner.cookie }),
          params({}),
        )
      ).json()) as { items: { id: string; isFavorite: boolean; readingStatus: string }[] };
      expect(
        listed.items.map((item) => item.id),
        query,
      ).toEqual([artifactId]);
      expect(listed.items[0], query).toMatchObject({ isFavorite: true, readingStatus: "read" });
    }
    const unread = (await (
      await listArtifactsRoute(
        request("/api/artifacts?status=unread", { cookie: owner.cookie }),
        params({}),
      )
    ).json()) as { items: unknown[] };
    expect(unread.items).toEqual([]);

    for (const body of [{}, { status: "skimmed" }, { opened: false }, { isFavorite: "yes" }]) {
      expect((await putState(body)).status, JSON.stringify(body)).toBe(400);
    }
    for (const query of ["favorite=yes", "status=skimmed", "sort=popular"]) {
      const response = await listArtifactsRoute(
        request(`/api/artifacts?${query}`, { cookie: owner.cookie }),
        params({}),
      );
      expect(response.status, query).toBe(400);
    }
  });

  it("is invisible to other workspaces; viewers read notes and keep their own state", async () => {
    const { note } = (await (await create({ bodyMarkdown: "私人筆記" })).json()) as {
      note: Note;
    };
    const stranger = await loggedIn();
    expect((await list(stranger.cookie)).status).toBe(404);
    expect((await create({ bodyMarkdown: "闖入" }, stranger.cookie)).status).toBe(404);
    expect((await patch(note.id, { bodyMarkdown: "偷改" }, stranger.cookie)).status).toBe(404);
    expect((await remove(note.id, stranger.cookie)).status).toBe(404);
    expect((await putState({ isFavorite: true }, stranger.cookie)).status).toBe(404);

    const viewer = await loggedIn();
    await testDb()
      .update(workspaceMembers)
      .set({ workspaceId: owner.workspaceId, role: "viewer" })
      .where(eq(workspaceMembers.userId, viewer.userId));
    expect((await list(viewer.cookie)).status).toBe(200);
    expect((await create({ bodyMarkdown: "檢視者" }, viewer.cookie)).status).toBe(403);
    expect((await patch(note.id, { bodyMarkdown: "檢視者" }, viewer.cookie)).status).toBe(403);
    const theirs = await putState({ isFavorite: true }, viewer.cookie);
    expect(theirs.status).toBe(200);
    expect(((await theirs.json()) as { readingState: State }).readingState).toMatchObject({
      status: "unread",
      isFavorite: true,
    });
  });
});
