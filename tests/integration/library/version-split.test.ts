import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, asc, eq } from "drizzle-orm";
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
  workspaces,
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
async function importOne(
  owner: Owner,
  filename: string,
  title: string,
  body: string,
  targetArtifactId?: string,
) {
  const item = await uploadFile(owner.actor, (await newBatch(owner.actor)).id, {
    filename,
    bytes: htmlDocument({ title, body }),
    targetArtifactId,
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
    // Restricted since (its link is suspended, not gone): the split-off work must stay so.
    await db.update(artifacts).set({ sensitivity: "restricted" }).where(eq(artifacts.id, old));
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
      sensitivity: "restricted",
      currentVersionId: second.versionId,
      createdBy: owner.userId,
      deletedAt: null,
    });
    await expect(
      createShare(
        db,
        owner.actor,
        artifact.id,
        { allowPreview: true, allowReading: true, allowDownload: true, expiresInDays: 1 },
        meta,
      ),
    ).rejects.toThrow();
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
      .where(
        and(
          eq(auditLogs.action, "artifact_version.split"),
          eq(auditLogs.targetId, second.versionId),
        ),
      );
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

    // A current version that is not the newest stays current when another is split off.
    const v4 = await importOne(
      owner,
      "tidal-notes (4).html",
      "潮汐筆記",
      "<p>第五版。</p>",
      v1.artifactId,
    );
    await db
      .update(artifacts)
      .set({ currentVersionId: v1.versionId })
      .where(eq(artifacts.id, v1.artifactId));
    expect((await split(v4, owner.cookie)).status).toBe(201);
    expect((await artifactRow(v1.artifactId)).currentVersionId).toBe(v1.versionId);
    // The newest was split off: the next version takes its number again (ADR-021).
    const v5 = await importOne(
      owner,
      "tidal-notes (5).html",
      "潮汐筆記",
      "<p>第六版。</p>",
      v1.artifactId,
    );
    expect(await versionsOf(v1.artifactId)).toEqual([
      { id: v1.versionId, number: 1 },
      { id: v3.versionId, number: 3 },
      { id: v5.versionId, number: 4 },
    ]);
  });

  it("names the new artifact after the version's own upload, not an earlier one of its bytes", async () => {
    const owner = await loggedIn();
    const bytes = `沙丘調查的另一份文字，內容與第一版無關，長度足以成為摘要。 ${newId()}`;
    // The same bytes came in before under another name, in a work since deleted: the import
    // reuses that stored original, which keeps the earlier name.
    const earlier = await uploadFile(owner.actor, (await newBatch(owner.actor)).id, {
      filename: "unrelated-name.txt",
      bytes,
    });
    await drainJobs();
    const [gone] = await db
      .select({ artifactId: importItems.resultArtifactId })
      .from(importItems)
      .where(eq(importItems.id, earlier.id));
    await db
      .update(artifacts)
      .set({ deletedAt: new Date() })
      .where(eq(artifacts.id, gone!.artifactId!));
    const first = await importOne(owner, "dune-survey.html", "沙丘調查", "<p>第一版。</p>");
    const item = await uploadFile(owner.actor, (await newBatch(owner.actor)).id, {
      filename: "dune-survey (1).txt",
      bytes,
    });
    await drainJobs();
    const [version] = await db
      .select({
        id: artifactVersions.id,
        artifactId: artifactVersions.artifactId,
        storedName: fileAssets.originalFilename,
      })
      .from(artifactVersions)
      .innerJoin(fileAssets, eq(fileAssets.id, artifactVersions.primaryFileId))
      .where(eq(artifactVersions.importItemId, item.id));
    expect(version!.artifactId).toBe(first.artifactId);
    expect(version!.storedName).toBe("unrelated-name.txt");

    const { artifact } = await splitVersion(
      db,
      owner.actor,
      { artifactId: first.artifactId, versionId: version!.id },
      meta,
    );
    expect((await artifactRow(artifact.id)).identityKey).toBe(
      identityKeyFor("dune-survey (1).txt"),
    );
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
  // The index job locks its version, then the artifact. The split moves one version (and its
  // chunks) and points the artifact at its newest remaining version: both are locked before
  // the artifact, so an index job for either cannot deadlock with it.
  for (const indexed of ["moved", "remaining"] as const) {
    for (const first of ["split", "index"] as const) {
      it(`cannot deadlock with the ${indexed} version's index job (${first} first)`, async () => {
        const owner = await loggedIn();
        const remaining = await importOne(owner, "reef-study.html", "珊瑚礁", "<p>甲。</p>");
        // The current version is the one split off, so the remaining one becomes current.
        const moved = await importOne(owner, "reef-study (1).html", "珊瑚礁", "<p>乙。</p>");
        const target = indexed === "moved" ? moved : remaining;

        const blocker = new Client({ connectionString: process.env.DATABASE_URL });
        const watcher = new Client({ connectionString: process.env.DATABASE_URL });
        await blocker.connect();
        await watcher.connect();
        try {
          // Another artifact writer (a note, a tag) holds the artifact for a moment; the split
          // and the index job (as after a re-extraction) queue behind it.
          await blocker.query("begin");
          await blocker.query("select id from artifacts where id = $1 for update", [
            moved.artifactId,
          ]);
          const run = {
            split: () => splitVersion(db, owner.actor, moved, meta),
            index: () => indexVersion(db, target.versionId),
          };
          const firstRun = run[first]();
          await lockWaiters(watcher, 1);
          const secondRun = run[first === "split" ? "index" : "split"]();
          await lockWaiters(watcher, 2);
          await blocker.query("rollback");
          // In another lock order one of them fails with "deadlock detected".
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
        expect((await artifactRow(moved.artifactId)).currentVersionId).toBe(remaining.versionId);
        // Each version's chunks are with the artifact it now belongs to.
        for (const [versionId, artifactId] of [
          [moved.versionId, version!.artifactId],
          [remaining.versionId, remaining.artifactId],
        ] as const) {
          const chunks = await db
            .select({ artifactId: contentChunks.artifactId })
            .from(contentChunks)
            .where(eq(contentChunks.artifactVersionId, versionId));
          expect(chunks.length).toBeGreaterThan(0);
          expect(new Set(chunks.map((chunk) => chunk.artifactId))).toEqual(new Set([artifactId]));
        }
      });
    }
  }
  it("starts over when a version is added before the artifact is locked", async () => {
    const owner = await loggedIn();
    const remaining = await importOne(owner, "atoll-study.html", "環礁", "<p>甲。</p>");
    const moved = await importOne(owner, "atoll-study (1).html", "環礁", "<p>乙。</p>");
    const added = newId();

    const blocker = new Client({ connectionString: process.env.DATABASE_URL });
    const importer = new Client({ connectionString: process.env.DATABASE_URL });
    const watcher = new Client({ connectionString: process.env.DATABASE_URL });
    await Promise.all([blocker.connect(), importer.connect(), watcher.connect()]);
    try {
      // A writer that lets versions be added (no key update) but keeps the split waiting.
      await blocker.query("begin");
      await blocker.query("select id from artifacts where id = $1 for no key update", [
        moved.artifactId,
      ]);
      const splitting = splitVersion(db, owner.actor, moved, meta);
      await lockWaiters(watcher, 1);
      // Meanwhile an import adds a newer version, and its index job takes it and waits for
      // the artifact. The split read the older version as the one to make current.
      await importer.query(
        `insert into artifact_versions (id, workspace_id, artifact_id, version_number, primary_file_id, content_kind, preview_kind)
         select $1, workspace_id, artifact_id, 3, primary_file_id, content_kind, preview_kind
         from artifact_versions where id = $2`,
        [added, remaining.versionId],
      );
      const indexing = indexVersion(db, added);
      await lockWaiters(watcher, 2);
      await blocker.query("rollback");
      // Pointing the artifact at the added version while holding the artifact would wait on
      // the index job, which waits for the artifact: the split must start over instead.
      const results = await Promise.allSettled([splitting, indexing]);
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    } finally {
      await Promise.all([blocker.end(), importer.end(), watcher.end()]);
    }
    expect((await artifactRow(moved.artifactId)).currentVersionId).toBe(added);
    expect(await versionsOf(moved.artifactId)).toEqual([
      { id: remaining.versionId, number: 1 },
      { id: added, number: 3 },
    ]);
  });
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
  /**
   * One line per artifact, sorted: its title and versions (number, original's hash, which is
   * current). Ids are left out, so a workspace and its restored copy compare equal.
   */
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
      .orderBy(asc(artifactVersions.versionNumber));
    const byArtifact = new Map<string, string[]>();
    for (const row of rows) {
      const current = row.versionId === row.currentVersionId ? " (current)" : "";
      const versions = byArtifact.get(row.artifactId) ?? [row.title];
      versions.push(`V${row.number} ${row.sha256.slice(0, 12)}${current}`);
      byArtifact.set(row.artifactId, versions);
    }
    return [...byArtifact.values()].map((parts) => parts.join(" | ")).sort();
  }

  it("come back as they are, the old artifact's numbers with their gap", async () => {
    const owner = await loggedIn();
    await importOne(owner, "estuary-log.html", "河口紀錄", "<p>第一版。</p>");
    const wrong = await importOne(owner, "estuary-log (1).html", "錯配的報告", "<p>別的。</p>");
    await importOne(owner, "estuary-log (2).html", "河口紀錄", "<p>第三版。</p>");
    await splitVersion(db, owner.actor, wrong, meta);
    const shape = await shapeOf(owner.workspaceId);
    expect(shape).toHaveLength(2);
    expect(shape[0]).toMatch(/^河口紀錄 \| V1 \w+ \| V3 \w+ \(current\)$/);
    expect(shape[1]).toMatch(/^錯配的報告 \| V1 \w+ \(current\)$/);
    const archive = await exportOf(owner.workspaceId);

    // Into another workspace while the source still holds the ids: copies, same shape.
    const target = await loggedIn();
    const report = await restore(archive, target);
    expect(report.counts.artifacts).toMatchObject({ copied: 2, failed: 0 });
    expect(report.counts.artifactVersions).toMatchObject({ copied: 3, failed: 0 });
    expect(await shapeOf(target.workspaceId)).toEqual(shape);

    // After losing the workspace: everything comes back under its own ids.
    await db.delete(workspaces).where(eq(workspaces.id, owner.workspaceId));
    const rebuilt = await loggedIn();
    const again = await restore(archive, rebuilt);
    expect(again.counts.artifacts).toMatchObject({ restored: 2, failed: 0 });
    expect(again.counts.artifactVersions).toMatchObject({ restored: 3, failed: 0 });
    expect(await shapeOf(rebuilt.workspaceId)).toEqual(shape);
    const [moved] = await db
      .select({ artifactId: artifactVersions.artifactId, number: artifactVersions.versionNumber })
      .from(artifactVersions)
      .where(eq(artifactVersions.id, wrong.versionId));
    expect(moved!.number).toBe(1);
    expect((await artifactRow(moved!.artifactId)).workspaceId).toBe(rebuilt.workspaceId);
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
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/^紅樹林圖鑑 \| V1 \w+ \| V2 \w+ \(current\)$/);
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
    // A copy of each archived artifact joins the two already there.
    const merged = await shapeOf(target.workspaceId);
    expect(merged).toHaveLength(3);
    expect(merged.filter((line) => line.startsWith("紅樹林圖鑑 | V1 "))).toHaveLength(2);
    expect(merged.filter((line) => /^另一本圖鑑 \| V1 \w+ \(current\)$/.test(line))).toHaveLength(
      1,
    );
  });
});
