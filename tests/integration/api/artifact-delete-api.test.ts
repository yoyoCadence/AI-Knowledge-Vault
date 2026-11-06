import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as listRoute } from "@/app/api/artifacts/route";
import { DELETE as deleteRoute, GET as detailRoute } from "@/app/api/artifacts/[id]/route";
import { POST as restoreRoute } from "@/app/api/artifacts/[id]/restore/route";
import { GET as searchRoute } from "@/app/api/search/route";
import { getEnv } from "@/infrastructure/config/env";
import { closeDb } from "@/infrastructure/database/client";
import {
  artifacts,
  artifactVersions,
  auditLogs,
  workspaceMembers,
} from "@/infrastructure/database/schema";
import { newId } from "@/lib/ids";
import { listDeletedArtifacts } from "@/modules/artifacts";
import { createShare, listShares, resolveShare } from "@/modules/sharing";
import { htmlDocument } from "@tests/fixtures/builders";
import { createTestAdmin, signInOk } from "../helpers/auth";
import { closeTestDb, testDb } from "../helpers/db";
import { drainJobs, newBatch, uploadFile } from "../helpers/imports";

/**
 * Soft delete and undo (ADR-017): DELETE /api/artifacts/:id and POST /api/artifacts/:id/restore,
 * through the route handlers, checked against what the library, search, detail and share links
 * show before, during and after.
 */

const db = testDb();
const env = getEnv();
const meta = { ipAddress: null, userAgent: null };

afterAll(async () => {
  await closeDb();
  await closeTestDb();
});

const params = <T>(value: T) => ({ params: Promise.resolve(value) });

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

type Owner = Awaited<ReturnType<typeof loggedIn>>;

async function importOne(owner: Owner, filename: string, title: string) {
  const item = await uploadFile(owner.actor, (await newBatch(owner.actor)).id, {
    filename,
    bytes: htmlDocument({ title, body: `<p>${title}的內容。</p>` }),
  });
  await drainJobs();
  const [version] = await db
    .select({ artifactId: artifactVersions.artifactId })
    .from(artifactVersions)
    .where(eq(artifactVersions.importItemId, item.id));
  return version!.artifactId;
}

const remove = (owner: Owner, artifactId: string, headers: Record<string, string> = {}) =>
  deleteRoute(
    new Request(`${env.APP_ORIGIN}/api/artifacts/${artifactId}`, {
      method: "DELETE",
      headers: { cookie: owner.cookie, origin: env.APP_ORIGIN, ...headers },
    }),
    params({ id: artifactId }),
  );

const restore = (owner: Owner, artifactId: string) =>
  restoreRoute(
    new Request(`${env.APP_ORIGIN}/api/artifacts/${artifactId}/restore`, {
      method: "POST",
      headers: { cookie: owner.cookie, origin: env.APP_ORIGIN },
    }),
    params({ id: artifactId }),
  );

const detail = (owner: Owner, artifactId: string) =>
  detailRoute(
    new Request(`${env.APP_ORIGIN}/api/artifacts/${artifactId}`, {
      headers: { cookie: owner.cookie },
    }),
    params({ id: artifactId }),
  );

async function libraryIds(owner: Owner) {
  const response = await listRoute(
    new Request(`${env.APP_ORIGIN}/api/artifacts`, { headers: { cookie: owner.cookie } }),
    params({}),
  );
  const body = (await response.json()) as { items: { id: string }[] };
  return body.items.map((item) => item.id);
}

async function searchIds(owner: Owner, q: string) {
  const response = await searchRoute(
    new Request(`${env.APP_ORIGIN}/api/search?q=${encodeURIComponent(q)}`, {
      headers: { cookie: owner.cookie },
    }),
    params({}),
  );
  const body = (await response.json()) as { items: { id: string }[] };
  return body.items.map((item) => item.id);
}

async function deletedAt(artifactId: string) {
  const [row] = await db
    .select({ deletedAt: artifacts.deletedAt })
    .from(artifacts)
    .where(eq(artifacts.id, artifactId));
  return row!.deletedAt;
}

async function auditActions(artifactId: string) {
  const rows = await db
    .select({ action: auditLogs.action })
    .from(auditLogs)
    .where(and(eq(auditLogs.targetType, "artifact"), eq(auditLogs.targetId, artifactId)))
    .orderBy(auditLogs.createdAt);
  return rows.map((row) => row.action);
}

describe("DELETE /api/artifacts/:id and POST /api/artifacts/:id/restore", () => {
  let owner: Owner;

  beforeAll(async () => {
    owner = await loggedIn();
  });

  it("hides the artifact everywhere; restore brings it back and revokes its old links", async () => {
    const artifactId = await importOne(owner, "delete-me.html", "鳶尾花觀察");
    const kept = await importOne(owner, "keep-me.html", "鳶尾花標本");
    const link = await createShare(
      db,
      owner.actor,
      artifactId,
      { allowPreview: false, allowReading: true, allowDownload: false },
      meta,
    );
    expect(await resolveShare(db, link.token)).not.toBeNull();
    expect(await searchIds(owner, "鳶尾花")).toEqual(expect.arrayContaining([artifactId, kept]));

    const response = await remove(owner, artifactId);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      artifact: { id: string; title: string; deletedAt: string };
    };
    expect(body.artifact).toMatchObject({ id: artifactId, title: "鳶尾花觀察" });
    expect(Number.isNaN(Date.parse(body.artifact.deletedAt))).toBe(false);

    // Gone from every reader; the other artifact is untouched.
    expect(await libraryIds(owner)).not.toContain(artifactId);
    expect(await libraryIds(owner)).toContain(kept);
    expect(await searchIds(owner, "鳶尾花")).toEqual([kept]);
    expect((await detail(owner, artifactId)).status).toBe(404);
    expect(await resolveShare(db, link.token)).toBeNull();
    const deleted = await listDeletedArtifacts(db, owner.actor, { limit: 10 });
    expect(deleted.items.map((item) => item.id)).toEqual([artifactId]);
    expect(deleted.items[0]).toMatchObject({ title: "鳶尾花觀察", contentKind: "html_document" });

    // A second delete (another tab, a double click) changes nothing: 404.
    const firstDeletedAt = await deletedAt(artifactId);
    expect((await remove(owner, artifactId)).status).toBe(404);
    expect(await deletedAt(artifactId)).toEqual(firstDeletedAt);

    const restored = await restore(owner, artifactId);
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual({
      artifact: { id: artifactId, title: "鳶尾花觀察", revokedShares: 1 },
    });

    expect(await libraryIds(owner)).toContain(artifactId);
    expect(await searchIds(owner, "鳶尾花")).toEqual(expect.arrayContaining([artifactId, kept]));
    expect((await detail(owner, artifactId)).status).toBe(200);
    expect((await listDeletedArtifacts(db, owner.actor, { limit: 10 })).items).toEqual([]);

    // ADR-020: an undo of a deletion revokes the suspended links. Whoever was handed the old
    // URL cannot read the artifact again; a new link works as usual.
    expect(await resolveShare(db, link.token)).toBeNull();
    expect(await listShares(db, owner.actor, artifactId)).toEqual([
      expect.objectContaining({ id: link.share.id, active: false }),
    ]);
    const fresh = await createShare(
      db,
      owner.actor,
      artifactId,
      { allowPreview: false, allowReading: true, allowDownload: false },
      meta,
    );
    expect(await resolveShare(db, fresh.token)).toMatchObject({ artifactId });

    // Restoring a live artifact is 404 too.
    expect((await restore(owner, artifactId)).status).toBe(404);
    expect(
      (await auditActions(artifactId)).filter((action) => /deleted|restored/.test(action)),
    ).toEqual(["artifact.deleted", "artifact.restored"]);
  });

  it("is 404 for another workspace, 403 for a viewer, and refuses cross-site requests", async () => {
    const artifactId = await importOne(owner, "guarded.html", "守門測試");
    const stranger = await loggedIn();
    expect((await remove(stranger, artifactId)).status).toBe(404);
    expect(await deletedAt(artifactId)).toBeNull();

    const viewer = await loggedIn();
    await db
      .update(workspaceMembers)
      .set({ workspaceId: owner.workspaceId, role: "viewer" })
      .where(eq(workspaceMembers.userId, viewer.userId));
    expect((await remove(viewer, artifactId)).status).toBe(403);
    expect((await remove(owner, artifactId, { origin: "https://evil.example" })).status).toBe(403);
    expect(await deletedAt(artifactId)).toBeNull();

    expect((await remove(owner, artifactId)).status).toBe(200);
    expect((await restore(stranger, artifactId)).status).toBe(404);
    expect((await restore(viewer, artifactId)).status).toBe(403);
    expect(await deletedAt(artifactId)).not.toBeNull();
    expect((await restore(owner, "not-a-uuid")).status).toBe(404);
  });

  it("lets the same file be imported again while its artifact is deleted", async () => {
    const first = await importOne(owner, "again.html", "再次匯入");
    expect((await remove(owner, first)).status).toBe(200);

    // Same name and bytes: neither a duplicate of, nor a new version of, the deleted artifact.
    const second = await importOne(owner, "again.html", "再次匯入");
    expect(second).not.toBe(first);
    expect(await libraryIds(owner)).toContain(second);

    // Restoring the first keeps both: nothing was merged or lost.
    expect((await restore(owner, first)).status).toBe(200);
    expect(await libraryIds(owner)).toEqual(expect.arrayContaining([first, second]));
  });

  it("lists deleted artifacts most recently deleted first, page by page", async () => {
    const lister = await loggedIn();
    const ids: string[] = [];
    for (const name of ["one", "two", "three"]) {
      const id = await importOne(lister, `${name}.html`, `刪除清單 ${name}`);
      expect((await remove(lister, id)).status).toBe(200);
      ids.push(id);
    }
    const first = await listDeletedArtifacts(db, lister.actor, { limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual([ids[2], ids[1]]);
    expect(first.nextCursor).not.toBeNull();
    const second = await listDeletedArtifacts(db, lister.actor, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((item) => item.id)).toEqual([ids[0]]);
    expect(second.nextCursor).toBeNull();
    // Another workspace's deleted artifacts are never listed.
    expect(
      (await listDeletedArtifacts(db, owner.actor, { limit: 50 })).items.map((item) => item.id),
    ).not.toEqual(expect.arrayContaining(ids));
  });
});
