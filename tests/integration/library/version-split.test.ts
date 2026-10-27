import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as splitRoute } from "@/app/api/artifacts/[id]/versions/[versionId]/split/route";
import { GET as searchRoute } from "@/app/api/search/route";
import { getEnv } from "@/infrastructure/config/env";
import { closeDb } from "@/infrastructure/database/client";
import {
  artifactNotes,
  artifacts,
  artifactTags,
  artifactVersions,
  auditLogs,
  contentChunks,
  fileAssets,
  importItems,
  shareLinks,
  workspaceMembers,
} from "@/infrastructure/database/schema";
import { newId } from "@/lib/ids";
import { getStorage } from "@/infrastructure/storage";
import { identityKeyFor, splitVersion, updateArtifact } from "@/modules/artifacts";
import { restoreArchive, restoreLimitsFromEnv, writeExport } from "@/modules/backup";
import { createNote } from "@/modules/notes";
import { createProject } from "@/modules/projects";
import { indexVersion } from "@/modules/search";
import { createShare } from "@/modules/sharing";
import { ensureTag, setArtifactTag } from "@/modules/tags";
import { htmlDocument } from "@tests/fixtures/builders";
import { createTestAdmin, signInOk } from "../helpers/auth";
import { closeTestDb, testDb } from "../helpers/db";
import { drainJobs, newBatch, uploadFile } from "../helpers/imports";

const db = testDb();
const env = getEnv();
const meta = { ipAddress: null, userAgent: "vitest" };

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
type Ids = { artifactId: string; versionId: string };

/** Imports one file and waits for it (and its search index) to finish. */
async function importOne(owner: Owner, filename: string, title: string, body: string) {
  const item = await uploadFile(owner.actor, (await newBatch(owner.actor)).id, {
    filename,
    bytes: htmlDocument({ title, body }),
  });
  await drainJobs();
  const [version] = await db
    .select({ id: artifactVersions.id, artifactId: artifactVersions.artifactId })
    .from(artifactVersions)
    .where(eq(artifactVersions.importItemId, item.id));
  return { artifactId: version!.artifactId, versionId: version!.id, itemId: item.id };
}

const split = (ids: Ids, cookie: string) =>
  splitRoute(
    new Request(
      `${env.APP_ORIGIN}/api/artifacts/${ids.artifactId}/versions/${ids.versionId}/split`,
      { method: "POST", headers: { cookie, origin: env.APP_ORIGIN } },
    ),
    params({ id: ids.artifactId, versionId: ids.versionId }),
  );

async function search(owner: Owner, q: string) {
  const response = await searchRoute(
    new Request(`${env.APP_ORIGIN}/api/search?q=${encodeURIComponent(q)}`, {
      headers: { cookie: owner.cookie },
    }),
    params({}),
  );
  return ((await response.json()) as { items: { id: string }[] }).items.map((item) => item.id);
}

const versionsOf = (artifactId: string) =>
  db
    .select({ id: artifactVersions.id, number: artifactVersions.versionNumber })
    .from(artifactVersions)
    .where(eq(artifactVersions.artifactId, artifactId))
    .orderBy(asc(artifactVersions.versionNumber));

async function artifactRow(id: string) {
  const [row] = await db.select().from(artifacts).where(eq(artifacts.id, id));
  return row!;
}

describe("POST /api/artifacts/:id/versions/:versionId/split", () => {
  it("moves a wrongly matched version, with its chunks, to a new artifact", async () => {
    const owner = await loggedIn();
    const first = await importOne(
      owner,
      "harbour-survey.html",
      "港灣調查",
      "<p>alphaword 港灣。</p>",
    );
    // A different study whose filename made the import take it for a new version.
    const second = await importOne(
      owner,
      "harbour-survey (1).html",
      "另一份研究",
      "<p>betaword 這其實是另一份研究的內容，被誤認為新版本。</p>",
    );
    expect(second.artifactId).toBe(first.artifactId);
    const old = first.artifactId;
    const project = await createProject(db, owner.actor, { title: "海岸專案" }, meta);
    await updateArtifact(db, owner.actor, old, { projectId: project.id }, meta);
    await createNote(db, owner.actor, old, "舊作品的筆記", meta);
    const tag = (await ensureTag(db, owner.actor, "港灣", meta)).tag;
    await setArtifactTag(db, owner.actor, { artifactId: old, tagId: tag.id, present: true }, meta);
    await createShare(
      db,
      owner.actor,
      old,
      { allowPreview: false, allowReading: true, allowDownload: false, expiresInDays: 1 },
      meta,
    );
    // The current version is the wrong one: its text is what search finds for the old artifact.
    expect(await search(owner, "betaword")).toEqual([old]);
    expect(await search(owner, "alphaword")).toEqual([]);

    const response = await split(second, owner.cookie);
    expect(response.status).toBe(201);
    const { artifact } = (await response.json()) as { artifact: { id: string; title: string } };
    expect(artifact.title).toBe("另一份研究");

    // The old artifact keeps its other version, its metadata and everything it owns.
    expect(await versionsOf(old)).toEqual([{ id: first.versionId, number: 1 }]);
    expect(await artifactRow(old)).toMatchObject({
      title: "港灣調查",
      currentVersionId: first.versionId,
      projectId: project.id,
      identityKey: identityKeyFor("harbour-survey.html"),
    });
    for (const table of [artifactNotes, artifactTags, shareLinks]) {
      const owned = await db.select().from(table).where(eq(table.artifactId, old));
      expect(owned).toHaveLength(1);
      expect(await db.select().from(table).where(eq(table.artifactId, artifact.id))).toEqual([]);
    }
    // The new one is made as the import would have made it alone, in the same project.
    expect(await versionsOf(artifact.id)).toEqual([{ id: second.versionId, number: 1 }]);
    expect(await artifactRow(artifact.id)).toMatchObject({
      workspaceId: owner.workspaceId,
      title: "另一份研究",
      summary: "betaword 這其實是另一份研究的內容，被誤認為新版本。",
      identityKey: identityKeyFor("harbour-survey (1).html"),
      projectId: project.id,
      visibility: "private",
      currentVersionId: second.versionId,
      createdBy: owner.userId,
      deletedAt: null,
    });
    const chunks = await db
      .select({ artifactId: contentChunks.artifactId })
      .from(contentChunks)
      .where(eq(contentChunks.artifactVersionId, second.versionId));
    expect(chunks.length).toBeGreaterThan(0);
    expect(new Set(chunks.map((chunk) => chunk.artifactId))).toEqual(new Set([artifact.id]));

    // Search follows at once: text, and titles in the metadata documents.
    expect(await search(owner, "betaword")).toEqual([artifact.id]);
    expect(await search(owner, "alphaword")).toEqual([old]);
    expect(await search(owner, "另一份研究")).toEqual([artifact.id]);
    expect(await search(owner, "港灣調查")).toEqual([old]);

    const [audit] = await db
      .select({ metadata: auditLogs.metadata, actor: auditLogs.actorUserId })
      .from(auditLogs)
      .where(eq(auditLogs.action, "artifact_version.split"))
      .orderBy(asc(auditLogs.createdAt))
      .limit(1);
    expect(audit).toEqual({
      actor: owner.userId,
      metadata: { fromArtifactId: old, fromVersionNumber: 2, toArtifactId: artifact.id },
    });
    // The import's record of what it did stays as it was.
    const [item] = await db
      .select({ resultArtifactId: importItems.resultArtifactId })
      .from(importItems)
      .where(eq(importItems.id, second.itemId));
    expect(item!.resultArtifactId).toBe(old);
  });

  it("an older version leaves the current one and the numbers' gap; the filename is ambiguous after", async () => {
    const owner = await loggedIn();
    const v1 = await importOne(owner, "tidal-notes.html", "潮汐筆記", "<p>第一版。</p>");
    const v2 = await importOne(owner, "tidal-notes (1).html", "潮汐筆記", "<p>第二版。</p>");
    const v3 = await importOne(owner, "tidal-notes (2).html", "潮汐筆記", "<p>第三版。</p>");
    expect(new Set([v1.artifactId, v2.artifactId, v3.artifactId]).size).toBe(1);

    expect((await split(v2, owner.cookie)).status).toBe(201);
    expect(await versionsOf(v1.artifactId)).toEqual([
      { id: v1.versionId, number: 1 },
      { id: v3.versionId, number: 3 },
    ]);
    expect((await artifactRow(v1.artifactId)).currentVersionId).toBe(v3.versionId);

    // Two artifacts now share the filename: the next import of it matches neither and says so.
    const next = await importOne(owner, "tidal-notes (3).html", "潮汐筆記", "<p>第四版。</p>");
    expect(next.artifactId).not.toBe(v1.artifactId);
    const [item] = await db
      .select({ warnings: importItems.warnings })
      .from(importItems)
      .where(eq(importItems.id, next.itemId));
    expect(item!.warnings.some((warning) => warning.startsWith("AMBIGUOUS_VERSION_MATCH"))).toBe(
      true,
    );
    expect(await versionsOf(v1.artifactId)).toHaveLength(2);
  });

  it("refuses an only version (409) and anything outside the artifact, workspace or role", async () => {
    const owner = await loggedIn();
    const only = await importOne(owner, "lonely-paper.html", "唯一版本", "<p>只有一版。</p>");
    const response = await split(only, owner.cookie);
    expect(response.status).toBe(409);

    const a1 = await importOne(owner, "kelp-forest.html", "海藻林", "<p>一。</p>");
    const a2 = await importOne(owner, "kelp-forest (1).html", "海藻林", "<p>二。</p>");
    expect(a2.artifactId).toBe(a1.artifactId);
    // A version of another artifact, unknown and malformed ids: 404 alike.
    expect((await split({ ...only, versionId: a2.versionId }, owner.cookie)).status).toBe(404);
    expect((await split({ ...a1, versionId: newId() }, owner.cookie)).status).toBe(404);
    expect((await split({ ...a1, versionId: "nope" }, owner.cookie)).status).toBe(404);

    const stranger = await loggedIn();
    expect((await split(a2, stranger.cookie)).status).toBe(404);
    const viewer = await loggedIn();
    await db
      .update(workspaceMembers)
      .set({ workspaceId: owner.workspaceId, role: "viewer" })
      .where(eq(workspaceMembers.userId, viewer.userId));
    expect((await split(a2, viewer.cookie)).status).toBe(403);

    await db
      .update(artifacts)
      .set({ deletedAt: new Date() })
      .where(eq(artifacts.id, a1.artifactId));
    expect((await split(a2, owner.cookie)).status).toBe(404);
    expect(await versionsOf(a1.artifactId)).toHaveLength(2);
    expect(await versionsOf(only.artifactId)).toHaveLength(1);
  });
});

/** Resolves once `count` sessions wait on a lock (polling pg_stat_activity), or throws. */
async function lockWaiters(watcher: Client, count: number) {
  for (const deadline = Date.now() + 10_000; ;) {
    const { rows } = await watcher.query<{ n: number }>(
      "select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()",
    );
    if (rows[0]!.n >= count) return;
    if (Date.now() > deadline) throw new Error(`fewer than ${count} sessions waited on a lock`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("a split and the search index job (lock order)", () => {
  for (const first of ["split", "index"] as const) {
    it(`cannot deadlock, and the chunks end with the new artifact (${first} first)`, async () => {
      const owner = await loggedIn();
      await importOne(owner, "reef-study.html", "珊瑚礁", "<p>甲。</p>");
      const moved = await importOne(owner, "reef-study (1).html", "珊瑚礁", "<p>乙。</p>");

      const blocker = new Client({ connectionString: process.env.DATABASE_URL });
      const watcher = new Client({ connectionString: process.env.DATABASE_URL });
      await blocker.connect();
      await watcher.connect();
      try {
        // Another artifact writer (a note, a tag) holds the artifact for a moment; the split
        // and the index job for the moved version (as after a re-extraction) queue behind it.
        await blocker.query("begin");
        await blocker.query("select id from artifacts where id = $1 for update", [
          moved.artifactId,
        ]);
        const run = {
          split: () => splitVersion(db, owner.actor, moved, meta),
          index: () => indexVersion(db, moved.versionId),
        };
        const firstRun = run[first]();
        await lockWaiters(watcher, 1);
        const secondRun = run[first === "split" ? "index" : "split"]();
        await lockWaiters(watcher, 2);
        await blocker.query("rollback");
        // In the other lock order one of them fails with "deadlock detected".
        const results = await Promise.allSettled([firstRun, secondRun]);
        expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      } finally {
        await blocker.end();
        await watcher.end();
      }

      const [version] = await db
        .select({ artifactId: artifactVersions.artifactId })
        .from(artifactVersions)
        .where(eq(artifactVersions.id, moved.versionId));
      expect(version!.artifactId).not.toBe(moved.artifactId);
      const chunks = await db
        .select({ artifactId: contentChunks.artifactId })
        .from(contentChunks)
        .where(eq(contentChunks.artifactVersionId, moved.versionId));
      expect(chunks.length).toBeGreaterThan(0);
      expect(new Set(chunks.map((chunk) => chunk.artifactId))).toEqual(
        new Set([version!.artifactId]),
      );
    });
  }
});

describe("export and restore of split artifacts", () => {
  let dir: string;
  let counter = 0;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "vault-split-"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  async function exportOf(workspaceId: string) {
    counter += 1;
    const file = path.join(dir, `export-${counter}.zip`);
    await writeExport(db, getStorage(), workspaceId, createWriteStream(file));
    return file;
  }
  const restore = (archivePath: string, target: Owner) =>
    restoreArchive(db, getStorage(), {
      archivePath,
      workspaceId: target.workspaceId,
      userId: target.userId,
      mode: "skip_existing",
      restoreId: crypto.randomUUID(),
      limits: restoreLimitsFromEnv(getEnv()),
    });
  /** Each artifact's title with its versions: number, original's hash, and which is current. */
  async function shapeOf(workspaceId: string) {
    const rows = await db
      .select({
        artifactId: artifacts.id,
        title: artifacts.title,
        currentVersionId: artifacts.currentVersionId,
        versionId: artifactVersions.id,
        number: artifactVersions.versionNumber,
        sha256: fileAssets.sha256,
      })
      .from(artifacts)
      .innerJoin(artifactVersions, eq(artifactVersions.artifactId, artifacts.id))
      .innerJoin(fileAssets, eq(fileAssets.id, artifactVersions.primaryFileId))
      .where(eq(artifacts.workspaceId, workspaceId))
      .orderBy(asc(artifacts.title), asc(artifactVersions.versionNumber));
    const shape = new Map<string, string[]>();
    for (const row of rows) {
      const current = row.versionId === row.currentVersionId ? " (current)" : "";
      shape.set(row.title, [
        ...(shape.get(row.title) ?? []),
        `V${row.number} ${row.sha256.slice(0, 12)}${current}`,
      ]);
    }
    return Object.fromEntries(shape);
  }

  it("come back as they are, the old artifact's numbers with their gap", async () => {
    const owner = await loggedIn();
    await importOne(owner, "estuary-log.html", "河口紀錄", "<p>第一版。</p>");
    const wrong = await importOne(owner, "estuary-log (1).html", "錯配的報告", "<p>別的。</p>");
    await importOne(owner, "estuary-log (2).html", "河口紀錄", "<p>第三版。</p>");
    await splitVersion(db, owner.actor, wrong, meta);
    const shape = await shapeOf(owner.workspaceId);
    expect(Object.keys(shape)).toEqual(["河口紀錄", "錯配的報告"]);
    expect(shape["河口紀錄"]!.map((line) => line.split(" ")[0])).toEqual(["V1", "V3"]);

    const target = await loggedIn();
    const report = await restore(await exportOf(owner.workspaceId), target);
    // Copies: the source workspace still holds the archived ids.
    expect(report.counts.artifacts).toMatchObject({ copied: 2, failed: 0 });
    expect(report.counts.artifactVersions).toMatchObject({ copied: 3, failed: 0 });
    expect(await shapeOf(target.workspaceId)).toEqual(shape);
  });

  it("over a database saved before the split: refused clearly, and a copy restore works", async () => {
    const owner = await loggedIn();
    await importOne(owner, "mangrove-atlas.html", "紅樹林圖鑑", "<p>第一版。</p>");
    const wrong = await importOne(owner, "mangrove-atlas (1).html", "另一本圖鑑", "<p>別的。</p>");
    const before = await exportOf(owner.workspaceId);
    await splitVersion(db, owner.actor, wrong, meta);
    const after = await exportOf(owner.workspaceId);

    // The database as it was before the split, then the newer archive over it.
    const target = await loggedIn();
    await restore(before, target);
    const kept = await shapeOf(target.workspaceId);
    expect(Object.keys(kept)).toEqual(["紅樹林圖鑑"]);
    const report = await restore(after, target);
    // skip_existing keeps the existing artifact as it is (its version stays), so the split-off
    // artifact cannot come back with that version: it fails with a reason, not a raw error.
    expect(report.counts.artifacts).toMatchObject({ skipped: 1, failed: 1 });
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]!.title).toBe("另一本圖鑑");
    expect(report.failures[0]!.error).toMatch(/split off .* restore in copy mode/);
    expect(await shapeOf(target.workspaceId)).toEqual(kept);

    const copied = await restoreArchive(db, getStorage(), {
      archivePath: after,
      workspaceId: target.workspaceId,
      userId: target.userId,
      mode: "copy",
      restoreId: crypto.randomUUID(),
      limits: restoreLimitsFromEnv(getEnv()),
    });
    expect(copied.counts.artifacts).toMatchObject({ failed: 0 });
    expect((await shapeOf(target.workspaceId))["另一本圖鑑"]).toHaveLength(1);
  });
});
