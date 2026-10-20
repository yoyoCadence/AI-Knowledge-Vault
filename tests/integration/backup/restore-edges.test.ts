import { createWriteStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEnv } from "@/infrastructure/config/env";
import { closeDb } from "@/infrastructure/database/client";
import { artifacts, artifactVersions, fileAssets } from "@/infrastructure/database/schema";
import { getStorage, LocalStorageAdapter } from "@/infrastructure/storage";
import { AppError } from "@/lib/errors";
import { restoreArchive, restoreLimitsFromEnv, writeExport } from "@/modules/backup";
import { htmlDocument, markdownDocument } from "@tests/fixtures/builders";
import { closeTestDb, testDb } from "../helpers/db";
import { createTestActor, drainJobs, newBatch, uploadFile } from "../helpers/imports";

/** Restore/export edge cases found in review (BACKUP_RECOVERY §6–8). */

const db = testDb();
let dir: string;
let counter = 0;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "vault-restore-edges-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await closeDb();
  await closeTestDb();
});

const uncaught: unknown[] = [];
const onUncaught = (error: unknown) => uncaught.push(error);

async function seed(files: { filename: string; bytes: Buffer | string }[]) {
  const actor = await createTestActor();
  const batch = await newBatch(actor);
  for (const file of files) {
    await uploadFile(actor, batch.id, file);
    await drainJobs(); // sequential, so filename versioning sees the previous version
  }
  return actor;
}

async function exportOf(workspaceId: string) {
  counter += 1;
  const file = path.join(dir, `export-${counter}.zip`);
  await writeExport(db, getStorage(), workspaceId, createWriteStream(file));
  return file;
}

function restore(
  archivePath: string,
  target: { workspaceId: string; userId: string },
  storage = getStorage(),
  mode: "skip_existing" | "copy" = "skip_existing",
) {
  return restoreArchive(db, storage, {
    archivePath,
    workspaceId: target.workspaceId,
    userId: target.userId,
    mode,
    restoreId: crypto.randomUUID(),
    limits: restoreLimitsFromEnv(getEnv()),
  });
}

async function artifactCount(workspaceId: string) {
  return (await db.select().from(artifacts).where(eq(artifacts.workspaceId, workspaceId))).length;
}

describe("export failure handling", () => {
  it("a corrupt or missing stored original fails the export cleanly (no crash, no hang)", async () => {
    process.on("uncaughtException", onUncaught);
    try {
      const actor = await seed([
        { filename: "edge-corrupt.html", bytes: htmlDocument({ title: `損毀 ${Math.random()}` }) },
      ]);
      const [asset] = await db
        .select()
        .from(fileAssets)
        .where(eq(fileAssets.workspaceId, actor.workspaceId));
      const objectFile = path.join(getEnv().LOCAL_STORAGE_DIR, "objects", asset!.storageKey);
      await writeFile(objectFile, "bit rot");
      await expect(exportOf(actor.workspaceId)).rejects.toSatisfy(
        (error: unknown) => error instanceof AppError && error.code === "ORIGINAL_CORRUPT",
      );
      await getStorage().deleteObject(asset!.storageKey);
      await expect(exportOf(actor.workspaceId)).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });
});

describe("export output failures", () => {
  it("an output that cannot be opened rejects the export instead of crashing", async () => {
    process.on("uncaughtException", onUncaught);
    try {
      const actor = await seed([
        { filename: "edge-output.html", bytes: htmlDocument({ title: `輸出 ${Math.random()}` }) },
      ]);
      const existing = path.join(dir, "already-there.zip");
      await writeFile(existing, "do not overwrite");
      await expect(
        writeExport(
          db,
          getStorage(),
          actor.workspaceId,
          createWriteStream(existing, { flags: "wx" }),
        ),
      ).rejects.toMatchObject({ code: "EEXIST" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });
});

describe("restore edge cases", () => {
  it("re-running skip_existing is idempotent even when the ids belong to another workspace", async () => {
    // The source workspace still exists, so every archived id is taken by someone else.
    const source = await seed([
      { filename: "edge-cross.html", bytes: htmlDocument({ title: `跨工作區 ${Math.random()}` }) },
    ]);
    const archive = await exportOf(source.workspaceId);
    const target = await createTestActor();
    const first = await restore(archive, target);
    expect(first.counts.artifacts).toMatchObject({ copied: 1, skipped: 0 });
    expect(first.warnings.join()).toMatch(/exists in another workspace/);
    const second = await restore(archive, target);
    expect(second.counts.artifacts).toMatchObject({ copied: 0, skipped: 1 });
    expect(second.counts.artifactVersions).toMatchObject({ skipped: 1, restored: 0 });
    expect(await artifactCount(target.workspaceId)).toBe(1);
    expect(await artifactCount(source.workspaceId)).toBe(1);
  });

  it("restores versions an existing artifact is missing (e.g. after a point-in-time DB restore)", async () => {
    const actor = await seed([
      { filename: "edge-versions-report.md", bytes: `${markdownDocument()}\nv1 ${Math.random()}` },
      {
        filename: "edge-versions-report (1).md",
        bytes: `${markdownDocument()}\nv2 ${Math.random()}`,
      },
    ]);
    const archive = await exportOf(actor.workspaceId);
    const [artifact] = await db
      .select()
      .from(artifacts)
      .where(eq(artifacts.workspaceId, actor.workspaceId));
    const versions = await db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.artifactId, artifact!.id));
    expect(versions).toHaveLength(2);
    const v1 = versions.find((version) => version.versionNumber === 1)!;
    const v2 = versions.find((version) => version.versionNumber === 2)!;
    // Simulate a database that lost version 2.
    await db
      .update(artifacts)
      .set({ currentVersionId: v1.id })
      .where(eq(artifacts.id, artifact!.id));
    await db.delete(artifactVersions).where(eq(artifactVersions.id, v2.id));

    const report = await restore(archive, actor);
    expect(report.counts.artifacts).toMatchObject({ skipped: 1 });
    expect(report.counts.artifactVersions).toMatchObject({ skipped: 1, restored: 1, failed: 0 });
    const [back] = await db
      .select()
      .from(artifactVersions)
      .where(
        and(eq(artifactVersions.artifactId, artifact!.id), eq(artifactVersions.versionNumber, 2)),
      );
    expect(back?.id).toBe(v2.id);
  });

  it("re-writes originals that are missing from storage even when their rows exist", async () => {
    const actor = await seed([
      { filename: "edge-repair.html", bytes: htmlDocument({ title: `修復 ${Math.random()}` }) },
    ]);
    const archive = await exportOf(actor.workspaceId);
    const [asset] = await db
      .select()
      .from(fileAssets)
      .where(eq(fileAssets.workspaceId, actor.workspaceId));
    await getStorage().deleteObject(asset!.storageKey);
    const report = await restore(archive, actor);
    expect(report.counts.fileAssets).toEqual({ stored: 0, reused: 1, repaired: 1 });
    expect(await getStorage().headObject(asset!.storageKey)).not.toBeNull();
  });

  it("round-trips a long file name whose 200th character is an emoji (surrogate pair)", async () => {
    const name = `${"a".repeat(199)}😀.html`;
    const source = await seed([
      { filename: name, bytes: htmlDocument({ title: `表情符號 ${Math.random()}` }) },
    ]);
    const archive = await exportOf(source.workspaceId);
    const target = await createTestActor();
    const fresh = new LocalStorageAdapter(path.join(dir, "emoji"), {
      signingSecret: "e".repeat(48),
      publicBaseUrl: "http://localhost:3999",
    });
    const report = await restore(archive, target, fresh);
    expect(report.failures).toEqual([]);
    expect(report.counts.fileAssets.stored).toBe(1);
  });
});
