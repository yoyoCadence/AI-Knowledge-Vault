import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEnv } from "@/infrastructure/config/env";
import { closeDb } from "@/infrastructure/database/client";
import { artifacts, fileAssets } from "@/infrastructure/database/schema";
import { getStorage } from "@/infrastructure/storage";
import { listArtifacts } from "@/modules/artifacts";
import type { Actor } from "@/modules/auth";
import { restoreArchive, restoreLimitsFromEnv, writeExport } from "@/modules/backup";
import {
  createCollection,
  deleteCollection,
  getArtifactCollections,
  listCollections,
  setCollectionItem,
  updateCollection,
} from "@/modules/collections";
import { htmlDocument } from "@tests/fixtures/builders";
import { closeTestDb, testDb } from "../helpers/db";
import { createTestActor, drainJobs, newBatch, uploadFile } from "../helpers/imports";

/** Collections through export and restore (BACKUP_RECOVERY §6, format v3). */
const db = testDb();
const meta = { ipAddress: null, userAgent: "vitest" };
let dir: string;
let counter = 0;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "vault-collections-restore-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await closeDb();
  await closeTestDb();
});

async function exportOf(workspaceId: string) {
  counter += 1;
  const file = path.join(dir, `export-${counter}.zip`);
  await writeExport(db, getStorage(), workspaceId, createWriteStream(file));
  return file;
}

function restore(archivePath: string, target: Actor, mode: "skip_existing" | "copy") {
  return restoreArchive(db, getStorage(), {
    archivePath,
    workspaceId: target.workspaceId,
    userId: target.userId,
    mode,
    restoreId: crypto.randomUUID(),
    limits: restoreLimitsFromEnv(getEnv()),
  });
}

async function importOne(actor: Actor, filename: string, title: string) {
  await uploadFile(actor, (await newBatch(actor)).id, {
    filename,
    bytes: htmlDocument({ title, body: `<p>${title}</p>` }),
  });
  await drainJobs();
  const [row] = await db
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(and(eq(artifacts.workspaceId, actor.workspaceId), eq(artifacts.title, title)));
  return row!.id;
}

const put = (actor: Actor, collectionId: string, artifactId: string) =>
  setCollectionItem(db, actor, { collectionId, artifactId, present: true }, meta);

async function titlesIn(actor: Actor, collectionId: string) {
  const { items } = await listArtifacts(db, actor, { limit: 50, filters: { collectionId } });
  return items.map((item) => item.title).sort();
}

describe("collections through export and restore", () => {
  it("merges into the target's collections of the same place and name", async () => {
    const source = await createTestActor();
    const city = await createCollection(db, source, { name: "城市", kind: "category" }, meta);
    const heat = await createCollection(db, source, { name: "熱島", parentId: city.id }, meta);
    await put(source, heat.id, await importOne(source, "merge-heat.html", "熱島觀測"));
    const archive = await exportOf(source.workspaceId);

    const target = await createTestActor();
    const theirCity = await createCollection(db, target, { name: "城市" }, meta);
    const theirHeat = await createCollection(
      db,
      target,
      { name: "熱島", parentId: theirCity.id },
      meta,
    );
    const report = await restore(archive, target, "skip_existing");
    expect(report.failures).toEqual([]);
    expect(report.counts.collections).toEqual({ restored: 0, skipped: 2, copied: 0, failed: 0 });
    expect(report.counts.collectionItems).toBe(1);
    expect((await listCollections(db, target)).map((row) => row.id)).toEqual([
      theirCity.id,
      theirHeat.id,
    ]);
    expect(await titlesIn(target, theirCity.id)).toEqual(["熱島觀測"]);
  });

  it("does not nest a merged branch too deep, and restores everything else", async () => {
    // Export E0 has 根 > 子; E1 adds 孫 > 曾孫 below. The target restores E0, then moves 根
    // deep into its own tree (子 lands on the deepest level allowed). Restoring E1 then cannot
    // place 孫 (or 曾孫 below it): they are reported, and 孫's artifact is restored without it.
    const source = await createTestActor();
    const root = await createCollection(db, source, { name: "根" }, meta);
    const child = await createCollection(db, source, { name: "子", parentId: root.id }, meta);
    const e0 = await exportOf(source.workspaceId);
    const grandchild = await createCollection(db, source, { name: "孫", parentId: child.id }, meta);
    await createCollection(db, source, { name: "曾孫", parentId: grandchild.id }, meta);
    const deepArtifact = await importOne(source, "too-deep.html", "放太深的作品");
    await put(source, grandchild.id, deepArtifact);
    await put(source, root.id, deepArtifact);
    const e1 = await exportOf(source.workspaceId);

    const target = await createTestActor();
    // The source still exists, so the restored collections have ids derived from the archive's.
    const first = await restore(e0, target, "skip_existing");
    const targetRoot = first.idMap[root.id]!;
    expect(targetRoot).toBeDefined();
    let parentId: string | null = null;
    for (let level = 0; level < 5; level += 1) {
      const created: { id: string } = await createCollection(
        db,
        target,
        { name: `層 ${level}`, parentId },
        meta,
      );
      parentId = created.id;
    }
    await updateCollection(db, target, targetRoot, { parentId }, meta);

    const report = await restore(e1, target, "skip_existing");
    expect(report.failures).toEqual([]);
    expect(report.counts.artifacts.copied).toBe(1); // under a derived id, as above
    expect(report.counts.collections).toEqual({ restored: 0, skipped: 2, copied: 0, failed: 2 });
    expect(report.counts.collectionItems).toBe(1);
    expect(report.counts.collectionItemsDropped).toBe(1);
    expect(report.warnings.join("\n")).toMatch(/2 collection\(s\) were not restored/);
    expect(report.warnings.join("\n")).toMatch(/1 collection item\(s\) were not restored/);
    const placed = await getArtifactCollections(db, target, report.idMap[deepArtifact]!);
    expect(placed.map((row) => row.id)).toEqual([targetRoot]);
    expect(Math.max(...(await listCollections(db, target)).map((row) => row.depth))).toBe(6);
  });

  it("drops the item of a collection deleted mid-restore instead of failing the artifact", async () => {
    const source = await createTestActor();
    const doomed = await createCollection(db, source, { name: "會被刪除" }, meta);
    await put(source, doomed.id, await importOne(source, "stale-collection.html", "過期集合"));
    const archive = await exportOf(source.workspaceId);

    // The target already stores the same original, so the restore can be paused on its row.
    const target = await createTestActor();
    await importOne(target, "stale-collection.html", "過期集合");
    const theirs = await createCollection(db, target, { name: "會被刪除" }, meta);
    const [asset] = await db
      .select({ id: fileAssets.id })
      .from(fileAssets)
      .where(eq(fileAssets.workspaceId, target.workspaceId));

    const blocker = new Client({ connectionString: process.env.DATABASE_URL });
    const watcher = new Client({ connectionString: process.env.DATABASE_URL });
    await blocker.connect();
    await watcher.connect();
    try {
      await blocker.query("begin");
      await blocker.query("select id from file_assets where id = $1 for update", [asset!.id]);
      const restoring = restore(archive, target, "copy");
      restoring.catch(() => undefined);
      for (const deadline = Date.now() + 10_000; ;) {
        const { rows } = await watcher.query(
          `select 1 from pg_stat_activity
           where wait_event_type = 'Lock' and query ilike '%insert into "artifact_versions"%'`,
        );
        if (rows.length > 0) break;
        if (Date.now() > deadline) throw new Error("the restore never waited");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await deleteCollection(db, target, theirs.id, meta);
      await blocker.query("commit");
      const report = await restoring;
      expect(report.failures).toEqual([]);
      expect(report.counts.artifacts.copied).toBe(1);
      expect(report.counts.collections.skipped).toBe(1);
      expect(report.counts.collectionItemsDropped).toBe(1);
      expect(report.warnings.join("\n")).toMatch(/deleted while the restore ran/);
    } finally {
      await blocker.end();
      await watcher.end();
    }
  });
});
