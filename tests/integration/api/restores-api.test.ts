import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as getRestoreRoute } from "@/app/api/restores/[id]/route";
import { POST as startRoute } from "@/app/api/restores/[id]/start/route";
import { GET as listRoute, POST as createRoute } from "@/app/api/restores/route";
import { PUT as localUpload } from "@/app/api/storage/local/upload/route";
import { getEnv } from "@/infrastructure/config/env";
import { closeDb } from "@/infrastructure/database/client";
import {
  artifacts,
  auditLogs,
  exportRuns,
  fileAssets,
  restoreRuns,
} from "@/infrastructure/database/schema";
import { getStorage, storageKeys, type StorageAdapter } from "@/infrastructure/storage";
import { newId } from "@/lib/ids";
import {
  ABANDONED_RESTORE_AFTER_MS,
  UPLOAD_REPLAY_WINDOW_MS,
  cleanupRestoreUploads,
  exportCleanupJobDefinition,
  restoreLimitsFromEnv,
  runRestore,
  writeExport,
} from "@/modules/backup";
import type { JobContext } from "@/modules/jobs";
import { SafeZip } from "@/modules/extraction";
import { htmlDocument } from "@tests/fixtures/builders";
import { buildZip, type ZipEntrySpec } from "@tests/fixtures/zip";
import { createTestAdmin, signInOk } from "../helpers/auth";
import { closeTestDb, testDb } from "../helpers/db";
import { drainJobs, newBatch, uploadFile } from "../helpers/imports";

const db = testDb();
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "vault-restore-api-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await closeDb();
  await closeTestDb();
});

const params = <T>(value: T) => ({ params: Promise.resolve(value) });
function apiRequest(urlPath: string, init: { method?: string; cookie: string; body?: unknown }) {
  const origin = getEnv().APP_ORIGIN;
  return new Request(`${origin}${urlPath}`, {
    method: init.method ?? "GET",
    headers: { origin, cookie: init.cookie, "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function owner() {
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
  return { cookie, actor };
}

type RestoreDto = {
  id: string;
  status: string;
  started: boolean;
  errorCode: string | null;
  report: {
    counts?: { artifacts: Record<string, number> };
    details?: { files?: string[]; nothingWritten?: boolean };
  } | null;
};

async function uploadArchive(cookie: string, bytes: Buffer, filename = "backup.zip") {
  const created = await createRoute(
    apiRequest("/api/restores", { method: "POST", cookie, body: { filename, size: bytes.length } }),
    params({}),
  );
  expect(created.status).toBe(201);
  const { restore, upload } = (await created.json()) as {
    restore: RestoreDto;
    upload: { url: string };
  };
  const put = await localUpload(
    new Request(upload.url, {
      method: "PUT",
      body: new Uint8Array(bytes),
      headers: { "content-length": String(bytes.length) },
    }),
  );
  expect(put.status).toBe(200);
  return restore;
}

const start = (cookie: string, id: string, mode = "skip_existing") =>
  startRoute(
    apiRequest(`/api/restores/${id}/start`, { method: "POST", cookie, body: { mode } }),
    params({ id }),
  );
const read = async (cookie: string, id: string) =>
  (
    (await (
      await getRestoreRoute(apiRequest(`/api/restores/${id}`, { cookie }), params({ id }))
    ).json()) as { restore: RestoreDto }
  ).restore;

/** The real storage with some methods replaced (fault injection). */
function hookedStorage(hooks: Partial<StorageAdapter>): StorageAdapter {
  const base = getStorage();
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property in hooks) return hooks[property as keyof StorageAdapter];
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Runs the restore job handler directly, as one attempt of the worker would. */
async function runAttempt(
  restoreId: string,
  storage: StorageAdapter,
  signal: AbortSignal,
  attemptCount = 1,
) {
  const ctx = {
    db,
    storage,
    signal,
    logger: pino({ level: "silent" }),
    job: { payload: { restoreId }, attemptCount },
    reportProgress: async () => undefined,
  } as unknown as JobContext;
  return runRestore(ctx, {
    ...restoreLimitsFromEnv(getEnv()),
    maxArchiveBytes: getEnv().RESTORE_MAX_ARCHIVE_BYTES,
  });
}

const artifactCount = async (workspaceId: string) =>
  (await db.select().from(artifacts).where(eq(artifacts.workspaceId, workspaceId))).length;

describe("restore over HTTP (BACKUP_RECOVERY §6)", () => {
  let archive: Buffer;

  beforeAll(async () => {
    const source = await owner();
    await uploadFile(source.actor, (await newBatch(source.actor)).id, {
      filename: "restore-api.html",
      bytes: htmlDocument({ title: `還原 API ${source.actor.workspaceId}` }),
    });
    await drainJobs();
    const file = path.join(dir, "source.zip");
    await writeExport(db, getStorage(), source.actor.workspaceId, createWriteStream(file));
    archive = await readFile(file);
  });

  it("uploads, verifies and restores an export; the upload is removed afterwards", async () => {
    const { cookie, actor } = await owner();
    const restore = await uploadArchive(cookie, archive);
    expect(restore).toMatchObject({ status: "queued", started: false });

    const started = await start(cookie, restore.id);
    expect(started.status).toBe(202);
    expect((await start(cookie, restore.id)).status).toBe(202); // idempotent
    await drainJobs();

    const done = await read(cookie, restore.id);
    expect(done.status).toBe("completed");
    // The source workspace still owns the archived ids, so they are restored under new ids.
    expect(done.report?.counts?.artifacts).toMatchObject({ copied: 1, failed: 0 });
    expect(
      (await db.select().from(artifacts).where(eq(artifacts.workspaceId, actor.workspaceId)))
        .length,
    ).toBe(1);
    const [run] = await db.select().from(restoreRuns).where(eq(restoreRuns.id, restore.id));
    expect(run?.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    const uploadKey = storageKeys.restoreUpload(actor.workspaceId, restore.id);
    expect(await getStorage().headObject(uploadKey)).toBeNull();
    // The key outlives the deletion until the signed upload URL has expired (replay window).
    expect(run?.sourceStorageKey).toBe(uploadKey);
    const audits = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.targetId, restore.id));
    expect(audits.map((row) => row.action).sort()).toEqual([
      "backup.restore.requested",
      "backup.restore.started",
    ]);
    const { items } = (await (
      await listRoute(apiRequest("/api/restores", { cookie }), params({}))
    ).json()) as { items: RestoreDto[] };
    expect(items.map((item) => item.id)).toEqual([restore.id]);
  });

  it("a tampered archive fails with CHECKSUM_MISMATCH and writes nothing", async () => {
    const { cookie, actor } = await owner();
    // Re-pack the export with one byte of an original flipped (checksums left as they were).
    const source = path.join(dir, "to-tamper.zip");
    await writeFile(source, archive);
    const zip = await SafeZip.open(source, restoreLimitsFromEnv(getEnv()));
    const entries: ZipEntrySpec[] = [];
    for (const entry of zip.inventory.entries) {
      if (entry.isDirectory) continue;
      const data = await zip.readBuffer(entry.path, 64 * 1024 * 1024);
      if (entry.path.startsWith("originals/")) data.writeUInt8(data.readUInt8(0) ^ 0xff, 0);
      entries.push({ name: entry.path, data });
    }
    zip.close();
    const restore = await uploadArchive(cookie, buildZip(entries));
    await start(cookie, restore.id);
    await drainJobs();
    const failed = await read(cookie, restore.id);
    expect(failed).toMatchObject({ status: "failed" });
    expect(failed.errorCode).toBe("CHECKSUM_MISMATCH");
    expect(failed.report?.details?.files?.[0]).toMatch(/^originals\//);
    expect(failed.report?.details?.nothingWritten).toBe(true);
    expect(
      (await db.select().from(artifacts).where(eq(artifacts.workspaceId, actor.workspaceId)))
        .length,
    ).toBe(0);
  });

  it("a mismatch found while storing originals does not claim nothing was written", async () => {
    const { cookie, actor } = await owner();
    // The archive verifies, but this workspace's content-addressed slot for one of its
    // originals already holds different bytes: the write phase stops with CHECKSUM_MISMATCH.
    const source = path.join(dir, "for-slot.zip");
    await writeFile(source, archive);
    const zip = await SafeZip.open(source, restoreLimitsFromEnv(getEnv()));
    const assets = JSON.parse(
      (await zip.readBuffer("metadata/file_assets.json", 1024 * 1024)).toString("utf8"),
    ) as { sha256: string }[];
    zip.close();
    await getStorage().putObject(
      storageKeys.original(actor.workspaceId, assets[0]!.sha256),
      Buffer.from("not the original"),
    );
    const restore = await uploadArchive(cookie, archive);
    await start(cookie, restore.id);
    await drainJobs();
    const failed = await read(cookie, restore.id);
    expect(failed).toMatchObject({ status: "failed", errorCode: "CHECKSUM_MISMATCH" });
    expect(failed.report?.details?.nothingWritten).toBeUndefined();
  });

  it("refuses to start before the upload, oversize declarations, and other workspaces", async () => {
    const { cookie } = await owner();
    const created = await createRoute(
      apiRequest("/api/restores", {
        method: "POST",
        cookie,
        body: { filename: "later.zip", size: 1234 },
      }),
      params({}),
    );
    const { restore } = (await created.json()) as { restore: RestoreDto };
    expect((await start(cookie, restore.id)).status).toBe(409); // UPLOAD_INCOMPLETE

    const tooBig = await createRoute(
      apiRequest("/api/restores", {
        method: "POST",
        cookie,
        body: { filename: "huge.zip", size: getEnv().RESTORE_MAX_ARCHIVE_BYTES + 1 },
      }),
      params({}),
    );
    expect(tooBig.status).toBe(413);

    const stranger = await owner();
    const response = await getRestoreRoute(
      apiRequest(`/api/restores/${restore.id}`, { cookie: stranger.cookie }),
      params({ id: restore.id }),
    );
    expect(response.status).toBe(404);
  });

  it("an attempt aborted by its timeout stops writing", async () => {
    const { cookie, actor } = await owner();
    const restore = await uploadArchive(cookie, archive);
    await db.update(restoreRuns).set({ status: "running" }).where(eq(restoreRuns.id, restore.id));
    const controller = new AbortController();
    // The worker aborts while the attempt is writing originals (after the download).
    const storage = hookedStorage({
      putObject: (...args) => {
        controller.abort(new Error("PROCESSING_TIMEOUT"));
        return getStorage().putObject(...args);
      },
    });
    await expect(runAttempt(restore.id, storage, controller.signal)).rejects.toThrow(
      "PROCESSING_TIMEOUT",
    );
    expect(await artifactCount(actor.workspaceId)).toBe(0);
    // The abort also stopped the original's own upload and its row.
    expect(
      await db.select().from(fileAssets).where(eq(fileAssets.workspaceId, actor.workspaceId)),
    ).toHaveLength(0);
  });

  it("a late attempt never overwrites the failure recorded for its timeout", async () => {
    const { cookie, actor } = await owner();
    const restore = await uploadArchive(cookie, archive);
    await db.update(restoreRuns).set({ status: "running" }).where(eq(restoreRuns.id, restore.id));
    // onFailed marks the run failed while this (zombie) attempt is still downloading.
    const storage = hookedStorage({
      getObject: async (key) => {
        await db
          .update(restoreRuns)
          .set({ status: "failed", errorCode: "PROCESSING_TIMEOUT" })
          .where(eq(restoreRuns.id, restore.id));
        return getStorage().getObject(key);
      },
    });
    await runAttempt(restore.id, storage, new AbortController().signal);
    const ended = await read(cookie, restore.id);
    expect(ended).toMatchObject({ status: "failed", errorCode: "PROCESSING_TIMEOUT" });
    expect(
      await getStorage().headObject(storageKeys.restoreUpload(actor.workspaceId, restore.id)),
    ).toBeNull();
  });

  it("an archive whose deletion failed is deleted by the job retry or the maintenance sweep", async () => {
    const { cookie, actor } = await owner();
    const uploadKey = (id: string) => storageKeys.restoreUpload(actor.workspaceId, id);
    const failingDelete = hookedStorage({
      deleteObject: async () => {
        throw new Error("storage briefly unavailable");
      },
    });

    // 1. The job's own retry: the run is completed, so the retry only finishes the deletion.
    const first = await uploadArchive(cookie, archive);
    await db.update(restoreRuns).set({ status: "running" }).where(eq(restoreRuns.id, first.id));
    const signal = new AbortController().signal;
    await expect(runAttempt(first.id, failingDelete, signal)).rejects.toThrow("briefly");
    expect((await read(cookie, first.id)).status).toBe("completed");
    expect(await getStorage().headObject(uploadKey(first.id))).not.toBeNull();
    expect(await runAttempt(first.id, getStorage(), signal)).toEqual({ skipped: "completed" });
    expect(await getStorage().headObject(uploadKey(first.id))).toBeNull();

    // 2. The hourly sweep, when every attempt failed to delete.
    const second = await uploadArchive(cookie, archive);
    await db.update(restoreRuns).set({ status: "running" }).where(eq(restoreRuns.id, second.id));
    await expect(runAttempt(second.id, failingDelete, signal)).rejects.toThrow("briefly");
    expect(await cleanupRestoreUploads(db, getStorage())).toBeGreaterThanOrEqual(1);
    expect(await getStorage().headObject(uploadKey(second.id))).toBeNull();
    const [run] = await db.select().from(restoreRuns).where(eq(restoreRuns.id, second.id));
    expect(run?.status).toBe("completed");
  });

  it("an upload never started is abandoned after a day and cannot start later", async () => {
    const { cookie, actor } = await owner();
    const stale = await uploadArchive(cookie, archive);
    const fresh = await uploadArchive(cookie, archive);
    await db
      .update(restoreRuns)
      .set({ createdAt: new Date(Date.now() - ABANDONED_RESTORE_AFTER_MS - 60_000) })
      .where(eq(restoreRuns.id, stale.id));

    expect(await cleanupRestoreUploads(db, getStorage())).toBeGreaterThanOrEqual(1);
    const abandoned = await read(cookie, stale.id);
    expect(abandoned).toMatchObject({ status: "failed", errorCode: "UPLOAD_INCOMPLETE" });
    const staleKey = storageKeys.restoreUpload(actor.workspaceId, stale.id);
    expect(await getStorage().headObject(staleKey)).toBeNull();
    const refused = await start(cookie, stale.id);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      "NOT_RETRYABLE",
    );

    // A recent upload is left alone and still starts normally.
    expect((await read(cookie, fresh.id)).status).toBe("queued");
    expect((await start(cookie, fresh.id)).status).toBe(202);
    await drainJobs();
    expect((await read(cookie, fresh.id)).status).toBe("completed");
  });

  it("a retried run's report says how its counts treat the earlier attempt, per mode", async () => {
    const { cookie } = await owner();
    const warningFor = async (mode: "skip_existing" | "copy") => {
      const restore = await uploadArchive(cookie, archive);
      await db
        .update(restoreRuns)
        .set({ status: "running", mode })
        .where(eq(restoreRuns.id, restore.id));
      await runAttempt(restore.id, getStorage(), new AbortController().signal, 2);
      const [run] = await db.select().from(restoreRuns).where(eq(restoreRuns.id, restore.id));
      const report = run!.report as { attempt: number; warnings: string[] };
      expect(report.attempt).toBe(2);
      return report.warnings[0]!;
    };
    const skip = await warningFor("skip_existing");
    expect(skip).toMatch(/^RETRIED_RUN: this run took 2 attempts; /);
    expect(skip).toContain("counted as skipped");
    const copy = await warningFor("copy");
    expect(copy).toContain("counted as copied");
    expect(copy).not.toContain("skipped");
  });

  it("a finished run stays started after its job row is pruned", async () => {
    const { cookie } = await owner();
    const restore = await uploadArchive(cookie, archive);
    await start(cookie, restore.id);
    await drainJobs();
    // Job pruning (ON DELETE SET NULL) clears job_id 30 days after the job ends.
    await db.update(restoreRuns).set({ jobId: null }).where(eq(restoreRuns.id, restore.id));
    expect(await read(cookie, restore.id)).toMatchObject({ status: "completed", started: true });
  });

  it("maintenance cleans what it can when some deletions keep failing", async () => {
    const { cookie, actor } = await owner();
    const stuckExportKey = storageKeys.export(actor.workspaceId, newId());
    await getStorage().putObject(stuckExportKey, Buffer.from("expired export"));
    await db.insert(exportRuns).values({
      workspaceId: actor.workspaceId,
      status: "completed",
      formatVersion: 1,
      storageKey: stuckExportKey,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const ended: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const restore = await uploadArchive(cookie, archive);
      await db
        .update(restoreRuns)
        .set({ status: "failed", completedAt: new Date() })
        .where(eq(restoreRuns.id, restore.id));
      ended.push(storageKeys.restoreUpload(actor.workspaceId, restore.id));
    }
    const [stuckRestoreKey, cleanableKey] = ended as [string, string];
    const stuck = new Set([stuckExportKey, stuckRestoreKey]);
    const storage = hookedStorage({
      deleteObject: async (key) => {
        if (stuck.has(key)) throw new Error("object locked");
        return getStorage().deleteObject(key);
      },
    });

    const cleanup = exportCleanupJobDefinition();
    const ctx = { db, storage } as unknown as JobContext;
    await expect(cleanup.handler(ctx)).rejects.toThrow(/cleanup step\(s\) failed/);
    // Neither the stuck export nor the stuck restore upload starved the remaining upload.
    expect(await getStorage().headObject(cleanableKey)).toBeNull();
    expect(await getStorage().headObject(stuckRestoreKey)).not.toBeNull();
    expect(await getStorage().headObject(stuckExportKey)).not.toBeNull();
    await getStorage().deleteObject(stuckExportKey);
    await db
      .update(exportRuns)
      .set({ storageKey: null })
      .where(eq(exportRuns.storageKey, stuckExportKey));
  });

  it("uploads that keep failing to delete never starve the ones after them", async () => {
    const { cookie, actor } = await owner();
    const keys: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const restore = await uploadArchive(cookie, archive);
      await db
        .update(restoreRuns)
        .set({ status: "failed", completedAt: new Date() })
        .where(eq(restoreRuns.id, restore.id));
      keys.push(storageKeys.restoreUpload(actor.workspaceId, restore.id));
    }
    // The two oldest (first by id) keep failing; with one row per page they would fill every
    // bounded batch if candidates were not paged past them.
    const stuck = new Set(keys.slice(0, 2));
    const storage = hookedStorage({
      deleteObject: async (key) => {
        if (stuck.has(key)) throw new Error("object locked");
        return getStorage().deleteObject(key);
      },
    });
    await expect(cleanupRestoreUploads(db, storage, new Date(), { pageSize: 1 })).rejects.toThrow(
      /cleanup step\(s\) failed/,
    );
    expect(await getStorage().headObject(keys[2]!)).toBeNull();
    expect(await getStorage().headObject(keys[0]!)).not.toBeNull();
  });

  it("a run its timeout already failed is never turned back into running", async () => {
    const { cookie, actor } = await owner();
    const restore = await uploadArchive(cookie, archive);
    // onFailed ran (timeout) before this attempt's handler got to claim the run.
    await db
      .update(restoreRuns)
      .set({ status: "failed", errorCode: "PROCESSING_TIMEOUT" })
      .where(eq(restoreRuns.id, restore.id));
    const result = await runAttempt(restore.id, getStorage(), new AbortController().signal);
    expect(result).toEqual({ skipped: "failed" });
    expect(await read(cookie, restore.id)).toMatchObject({
      status: "failed",
      errorCode: "PROCESSING_TIMEOUT",
    });
    expect(await artifactCount(actor.workspaceId)).toBe(0);
    const uploadKey = storageKeys.restoreUpload(actor.workspaceId, restore.id);
    expect(await getStorage().headObject(uploadKey)).toBeNull();
  });

  it("an aborted maintenance cleanup stops instead of running on detached", async () => {
    const { cookie, actor } = await owner();
    const restore = await uploadArchive(cookie, archive);
    await db
      .update(restoreRuns)
      .set({ status: "failed", completedAt: new Date() })
      .where(eq(restoreRuns.id, restore.id));
    const controller = new AbortController();
    controller.abort(new Error("PROCESSING_TIMEOUT"));
    const ctx = { db, storage: getStorage(), signal: controller.signal } as unknown as JobContext;
    await expect(exportCleanupJobDefinition().handler(ctx)).rejects.toThrow("PROCESSING_TIMEOUT");
    // Nothing was deleted after the abort; the next (un-aborted) run picks it up.
    const uploadKey = storageKeys.restoreUpload(actor.workspaceId, restore.id);
    expect(await getStorage().headObject(uploadKey)).not.toBeNull();
    await cleanupRestoreUploads(db, getStorage());
    expect(await getStorage().headObject(uploadKey)).toBeNull();
  });

  it("an upload replayed after the restore is deleted until its URL expires", async () => {
    const { cookie, actor } = await owner();
    const restore = await uploadArchive(cookie, archive);
    await start(cookie, restore.id);
    await drainJobs();
    const uploadKey = storageKeys.restoreUpload(actor.workspaceId, restore.id);
    expect(await getStorage().headObject(uploadKey)).toBeNull();

    // The still-valid signed PUT is replayed: the archive is back under the same key.
    await getStorage().putObject(uploadKey, archive);
    const [run] = await db.select().from(restoreRuns).where(eq(restoreRuns.id, restore.id));
    await cleanupRestoreUploads(db, getStorage(), new Date(run!.createdAt.getTime() + 60_000));
    expect(await getStorage().headObject(uploadKey)).toBeNull();
    expect(
      (await db.select().from(restoreRuns).where(eq(restoreRuns.id, restore.id)))[0],
    ).toMatchObject({ sourceStorageKey: uploadKey });

    // A slow PUT authorized just before the URL expired can still land hours later.
    await getStorage().putObject(uploadKey, archive);
    await cleanupRestoreUploads(
      db,
      getStorage(),
      new Date(run!.createdAt.getTime() + 2 * 3600_000),
    );
    expect(await getStorage().headObject(uploadKey)).toBeNull();
    expect(
      (await db.select().from(restoreRuns).where(eq(restoreRuns.id, restore.id)))[0],
    ).toMatchObject({ sourceStorageKey: uploadKey });

    // Once that window has passed, a final sweep forgets the key.
    const later = new Date(run!.createdAt.getTime() + UPLOAD_REPLAY_WINDOW_MS + 60_000);
    await getStorage().putObject(uploadKey, archive);
    await cleanupRestoreUploads(db, getStorage(), later);
    expect(await getStorage().headObject(uploadKey)).toBeNull();
    expect(
      (await db.select().from(restoreRuns).where(eq(restoreRuns.id, restore.id)))[0],
    ).toMatchObject({ sourceStorageKey: null });
  });
});
