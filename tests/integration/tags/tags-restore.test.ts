import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEnv } from "@/infrastructure/config/env";
import { closeDb } from "@/infrastructure/database/client";
import { artifacts, artifactTags, fileAssets, tags } from "@/infrastructure/database/schema";
import { getStorage } from "@/infrastructure/storage";
import type { Actor } from "@/modules/auth";
import { restoreArchive, restoreLimitsFromEnv, writeExport } from "@/modules/backup";
import {
  deleteTag,
  ensureTag,
  mergeTag,
  normalizeTagName,
  renameTag,
  setArtifactTag,
} from "@/modules/tags";
import { htmlDocument } from "@tests/fixtures/builders";
import { closeTestDb, testDb } from "../helpers/db";
import { createTestActor, drainJobs, newBatch, uploadFile } from "../helpers/imports";

/** Tags through export and restore: the review cases of PR 13 (BACKUP_RECOVERY §6). */
const db = testDb();
const meta = { ipAddress: null, userAgent: "vitest" };
let dir: string;
let counter = 0;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "vault-tags-restore-"));
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

function restore(
  archivePath: string,
  target: Actor,
  mode: "skip_existing" | "copy",
  restoreId = crypto.randomUUID(),
) {
  return restoreArchive(db, getStorage(), {
    archivePath,
    workspaceId: target.workspaceId,
    userId: target.userId,
    mode,
    restoreId,
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

/** Waits until some session is blocked on a lock while running a statement like `pattern`. */
async function waitForLockWait(client: Client, pattern: string) {
  for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
    const { rows } = await client.query(
      "select 1 from pg_stat_activity where wait_event_type = 'Lock' and query ilike $1",
      [pattern],
    );
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no session waited on ${pattern}`);
}

async function withClients(run: (blocker: Client, watcher: Client) => Promise<void>) {
  const blocker = new Client({ connectionString: process.env.DATABASE_URL });
  const watcher = new Client({ connectionString: process.env.DATABASE_URL });
  await blocker.connect();
  await watcher.connect();
  try {
    await run(blocker, watcher);
  } finally {
    await blocker.end();
    await watcher.end();
  }
}

describe("tags through export and restore", () => {
  it("restores an artifact whose two archived tags map to one existing tag", async () => {
    // W1 exports tag a = "bar" (E0); then a is renamed "foo", a new tag b = "bar" appears,
    // and a new artifact carries both (E1). Restoring E0 then E1 into W2 maps both a and b
    // onto W2's "bar": the artifact must still be restored, with that tag once.
    const source = await createTestActor();
    const a = (await ensureTag(db, source, "bar", meta)).tag;
    const older = await exportOf(source.workspaceId);
    await renameTag(db, source, a.id, "foo", meta);
    const b = (await ensureTag(db, source, "bar", meta)).tag;
    const x = await importOne(source, "two-tags.html", "兩個標籤");
    for (const tagId of [a.id, b.id])
      await setArtifactTag(db, source, { artifactId: x, tagId, present: true }, meta);
    const newer = await exportOf(source.workspaceId);

    const target = await createTestActor();
    await restore(older, target, "skip_existing");
    const report = await restore(newer, target, "skip_existing");
    expect(report.failures).toEqual([]);
    expect(report.counts.artifacts.failed).toBe(0);
    const [restored] = await db
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(and(eq(artifacts.workspaceId, target.workspaceId), eq(artifacts.title, "兩個標籤")));
    expect(restored).toBeDefined();
    const links = await db
      .select({ name: tags.name })
      .from(artifactTags)
      .innerJoin(tags, eq(tags.id, artifactTags.tagId))
      .where(eq(artifactTags.artifactId, restored!.id));
    expect(links).toEqual([{ name: "bar" }]);
    expect(report.counts.artifactTags).toBe(1);
  });

  it("counts a copy-mode retry the same as the attempt it resumes", async () => {
    const source = await createTestActor();
    const x = await importOne(source, "copy-retry.html", "副本重試");
    const tag = (await ensureTag(db, source, "只在來源", meta)).tag;
    await setArtifactTag(db, source, { artifactId: x, tagId: tag.id, present: true }, meta);
    const archive = await exportOf(source.workspaceId);

    const target = await createTestActor();
    const restoreId = crypto.randomUUID();
    const first = await restore(archive, target, "copy", restoreId);
    const retry = await restore(archive, target, "copy", restoreId);
    expect(first.counts.tags).toMatchObject({ copied: 1, skipped: 0 });
    expect(retry.counts.tags).toEqual(first.counts.tags);
    // The links the first attempt wrote count again, as the copied artifact does.
    expect(first.counts.artifactTags).toBe(1);
    expect(retry.counts.artifactTags).toBe(1);
    expect(
      await db.select().from(tags).where(eq(tags.workspaceId, target.workspaceId)),
    ).toHaveLength(1);
  });

  it("never deadlocks with a tag merge running at the same time", async () => {
    // The archive's links map to two target tags whose ids are in the opposite order. A merge
    // holds the lower one and waits for the higher; the restore must not grab them the other
    // way round (it used to insert links in archive order and deadlock, 40P01).
    const source = await createTestActor();
    const first = (await ensureTag(db, source, "甲標籤", meta)).tag;
    const second = (await ensureTag(db, source, "乙標籤", meta)).tag;
    const x = await importOne(source, "restore-merge.html", "還原與合併");
    for (const tagId of [first.id, second.id])
      await setArtifactTag(db, source, { artifactId: x, tagId, present: true }, meta);
    const archive = await exportOf(source.workspaceId);
    const [lowInArchive, highInArchive] = [first, second].sort((a, b) => (a.id < b.id ? -1 : 1));

    const target = await createTestActor();
    const suffix = () => crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const high = `ffffffff-ffff-4fff-bfff-${suffix()}`;
    const low = `00000000-0000-4000-8000-${suffix()}`;
    await db.insert(tags).values([
      { id: high, workspaceId: target.workspaceId, ...normalizeTagName(lowInArchive!.name) },
      { id: low, workspaceId: target.workspaceId, ...normalizeTagName(highInArchive!.name) },
    ]);

    await withClients(async (blocker, watcher) => {
      await blocker.query("begin");
      await blocker.query("select id from tags where id = $1 for no key update", [high]);
      const merge = mergeTag(db, target, low, high, meta);
      merge.catch(() => undefined);
      await waitForLockWait(watcher, '%from "tags"%for update%');
      const restoring = restore(archive, target, "skip_existing");
      restoring.catch(() => undefined);
      await waitForLockWait(watcher, '%from "tags"%for key share%');
      await blocker.query("commit");
      const [merged, restored] = await Promise.allSettled([merge, restoring]);
      expect(merged.status).toBe("fulfilled");
      expect(restored.status).toBe("fulfilled");
      const report = (restored as PromiseFulfilledResult<Awaited<typeof restoring>>).value;
      expect(report.failures).toEqual([]);
      // The merge deleted the lower tag; its link went with it, the higher one was written.
      expect(report.counts.artifactTags).toBe(1);
      expect(report.counts.artifactTagsDropped).toBe(1);
    });
  });

  it("drops the link of a tag deleted mid-restore instead of failing the artifact", async () => {
    const source = await createTestActor();
    const tag = (await ensureTag(db, source, "會被刪除", meta)).tag;
    const x = await importOne(source, "stale-tag.html", "過期標籤");
    await setArtifactTag(db, source, { artifactId: x, tagId: tag.id, present: true }, meta);
    const archive = await exportOf(source.workspaceId);

    // The target already stores the same original, so the restore can be paused on its row.
    const target = await createTestActor();
    await importOne(target, "stale-tag.html", "過期標籤");
    const targetTag = (await ensureTag(db, target, "會被刪除", meta)).tag;
    const [asset] = await db
      .select({ id: fileAssets.id })
      .from(fileAssets)
      .where(eq(fileAssets.workspaceId, target.workspaceId));

    await withClients(async (blocker, watcher) => {
      await blocker.query("begin");
      await blocker.query("select id from file_assets where id = $1 for update", [asset!.id]);
      const restoring = restore(archive, target, "copy");
      restoring.catch(() => undefined);
      await waitForLockWait(watcher, '%insert into "artifact_versions"%');
      await deleteTag(db, target, targetTag.id, meta);
      await blocker.query("commit");
      const report = await restoring;
      expect(report.failures).toEqual([]);
      expect(report.counts.artifacts.copied).toBe(1);
      expect(report.counts.artifactTagsDropped).toBe(1);
      expect(report.warnings.join("\n")).toMatch(/deleted or merged while the restore ran/);
    });
  });
});
