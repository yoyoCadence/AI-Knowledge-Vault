import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEnv } from "@/infrastructure/config/env";
import { closeDb } from "@/infrastructure/database/client";
import { artifacts, artifactTags, tags } from "@/infrastructure/database/schema";
import { getStorage } from "@/infrastructure/storage";
import type { Actor } from "@/modules/auth";
import { restoreArchive, restoreLimitsFromEnv, writeExport } from "@/modules/backup";
import { ensureTag, renameTag, setArtifactTag } from "@/modules/tags";
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
    expect(
      await db.select().from(tags).where(eq(tags.workspaceId, target.workspaceId)),
    ).toHaveLength(1);
  });
});
