import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { and, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import type { Database, DbExecutor } from "@/infrastructure/database/client";
import { exportRuns } from "@/infrastructure/database/schema";
import { storageKeys, type SignedRequest, type StorageAdapter } from "@/infrastructure/storage";
import { AppError, notFound } from "@/lib/errors";
import { newId } from "@/lib/ids";
import { recordAudit, type RequestMeta } from "@/modules/audit";
import type { Actor } from "@/modules/auth";
import { sha256OfFile } from "@/modules/files/hash";
import { enqueueJob, type JobContext, type JobDefinition } from "@/modules/jobs";
import { encryptVerified, type EncryptionOptions } from "./encryption";
import { EXPORT_FORMAT, EXPORT_FORMAT_VERSION } from "./format";
import { writeExport } from "./export";
import { eachRowIndependently } from "./each-independently";
import { cleanupRestoreUploads } from "./restore-runs";

/**
 * Export runs (BACKUP_RECOVERY §3): request → `export.create` job → archive in storage under
 * `ws/{ws}/exports/{id}.zip` → 5-minute signed, audited download. Archives expire after
 * EXPORT_RETENTION_DAYS; the downloaded file is the owner's copy, not the app's storage.
 */

export const EXPORT_JOB_TYPE = "export.create";
export const EXPORT_CLEANUP_JOB_TYPE = "maintenance.cleanup_exports";
export const EXPORT_RETENTION_DAYS = 7;
export const EXPORT_DOWNLOAD_TTL_SECONDS = 300;

export type ExportRun = typeof exportRuns.$inferSelect;

export function toExportDto(run: ExportRun) {
  return {
    id: run.id,
    status: run.status,
    formatVersion: run.formatVersion,
    filename: run.filename,
    byteSize: run.byteSize,
    sha256: run.sha256,
    summary: run.manifestSummary,
    errorMessage: run.errorMessage,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
    expiresAt: run.expiresAt,
    downloadable:
      run.status === "completed" &&
      run.storageKey !== null &&
      run.expiresAt !== null &&
      run.expiresAt.getTime() > Date.now(),
  };
}

export async function requestExport(
  db: Database,
  actor: Actor,
  meta: RequestMeta,
): Promise<ExportRun> {
  return db.transaction(async (tx) => {
    const id = newId();
    const { job } = await enqueueJob(tx, {
      type: EXPORT_JOB_TYPE,
      idempotencyKey: `${EXPORT_JOB_TYPE}:${id}`,
      workspaceId: actor.workspaceId,
      payload: { exportId: id },
      maxAttempts: 3,
    });
    const [run] = await tx
      .insert(exportRuns)
      .values({
        id,
        workspaceId: actor.workspaceId,
        requestedBy: actor.userId,
        formatVersion: EXPORT_FORMAT_VERSION,
        jobId: job.id,
      })
      .returning();
    await recordAudit(tx, {
      action: "backup.export.requested",
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      targetType: "export_run",
      targetId: id,
      ...meta,
    });
    return run!;
  });
}

export async function listExports(db: DbExecutor, actor: Actor, limit = 20): Promise<ExportRun[]> {
  return db
    .select()
    .from(exportRuns)
    .where(eq(exportRuns.workspaceId, actor.workspaceId))
    .orderBy(desc(exportRuns.createdAt))
    .limit(limit);
}

/** A completed, unexpired export of the actor's workspace, or NOT_FOUND / CONFLICT. */
async function downloadableRun(db: DbExecutor, actor: Actor, exportId: string) {
  const [run] = await db
    .select()
    .from(exportRuns)
    .where(and(eq(exportRuns.id, exportId), eq(exportRuns.workspaceId, actor.workspaceId)));
  if (!run) throw notFound("Export");
  if (
    !toExportDto(run).downloadable ||
    !run.storageKey ||
    !run.filename ||
    !run.sha256 ||
    run.byteSize === null
  ) {
    throw new AppError("CONFLICT", "This export is not ready or has expired");
  }
  return {
    ...run,
    storageKey: run.storageKey,
    filename: run.filename,
    sha256: run.sha256,
    byteSize: run.byteSize,
  };
}

export async function createExportDownload(
  db: DbExecutor,
  storage: StorageAdapter,
  actor: Actor,
  exportId: string,
  meta: RequestMeta,
): Promise<SignedRequest & { filename: string; sha256: string }> {
  const run = await downloadableRun(db, actor, exportId);
  const signed = await storage.createSignedDownloadUrl(run.storageKey, {
    expiresInSeconds: EXPORT_DOWNLOAD_TTL_SECONDS,
    filename: run.filename,
    contentType: "application/zip",
  });
  await recordAudit(db, {
    action: "backup.export.downloaded",
    workspaceId: actor.workspaceId,
    actorUserId: actor.userId,
    targetType: "export_run",
    targetId: run.id,
    metadata: { sha256: run.sha256, byteSize: run.byteSize },
    ...meta,
  });
  return { ...signed, filename: run.filename, sha256: run.sha256 };
}

/**
 * An export streamed out encrypted with age (P1A-ENC, ADR-022): the stored archive passes
 * through the encrypter on its way to the owner, verified against its SHA-256 as it goes.
 * The passphrase or recipients are used here and nowhere else: not stored, not audited.
 */
export async function openEncryptedExport(
  db: DbExecutor,
  storage: StorageAdapter,
  actor: Actor,
  exportId: string,
  options: EncryptionOptions,
  meta: RequestMeta,
) {
  const run = await downloadableRun(db, actor, exportId);
  const { body, info } = await storage.getObject(run.storageKey);
  let stream: Awaited<ReturnType<typeof encryptVerified>> | null = null;
  try {
    // A stored object of another size cannot be the archive: refuse before any header goes out
    // (the response's content-length is the encrypted size of the recorded one).
    if (info.size !== run.byteSize) {
      throw new AppError("CHECKSUM_MISMATCH", "The stored archive does not match its record");
    }
    stream = await encryptVerified(Readable.toWeb(body) as ReadableStream<Uint8Array>, options, {
      sha256: run.sha256,
      byteSize: run.byteSize,
    });
    await recordAudit(db, {
      action: "backup.export.downloaded",
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      targetType: "export_run",
      targetId: run.id,
      metadata: {
        sha256: run.sha256,
        byteSize: run.byteSize,
        encryption: options.kind,
        ...(options.kind === "recipients" ? { recipients: options.recipients.length } : {}),
      },
      ...meta,
    });
  } catch (error) {
    // Nothing will read the archive: release the storage stream (a file or a pooled socket).
    await stream?.cancel().catch(() => undefined);
    body.destroy();
    throw error;
  }
  return {
    stream,
    filename: `${run.filename}.age`,
    byteSize: stream.size(run.byteSize),
    sha256: run.sha256,
  };
}

/**
 * The sidecar of an encrypted export (BACKUP_RECOVERY §4): what the archive holds, readable
 * without decrypting it, so a set of backups can be inventoried. It describes the plaintext
 * archive (its SHA-256 checks the decrypted copy): file name, size, format, when and by which
 * app version it was made, and its counts. It holds nothing secret, and not the workspace's
 * name, which sits beside the backup in whatever cloud it is kept.
 */
export async function exportSidecar(db: DbExecutor, actor: Actor, exportId: string) {
  const run = await downloadableRun(db, actor, exportId);
  return {
    filename: `${run.filename}.age.manifest.json`,
    sidecar: {
      format: `${EXPORT_FORMAT}-sidecar`,
      sidecarVersion: 1,
      encrypted: { format: "age", filename: `${run.filename}.age` },
      archive: {
        filename: run.filename,
        byteSize: run.byteSize,
        sha256: run.sha256,
        formatVersion: run.formatVersion,
      },
      manifest: run.manifestSummary,
    },
  };
}

/**
 * Job handler. Idempotent: a completed run is skipped; otherwise the archive is rebuilt into a
 * temp file and uploaded to the run's fixed key (a retry overwrites a partial upload).
 */
export async function runExport(ctx: JobContext): Promise<Record<string, unknown>> {
  const { db, storage } = ctx;
  const exportId = String(ctx.job.payload.exportId ?? "");
  const [run] = await db.select().from(exportRuns).where(eq(exportRuns.id, exportId));
  if (!run) return { skipped: "missing_run" };
  if (run.status === "completed") return { skipped: "completed" };
  await db
    .update(exportRuns)
    .set({ status: "running", errorMessage: null })
    .where(eq(exportRuns.id, run.id));

  const dir = await mkdtemp(path.join(tmpdir(), "vault-export-"));
  try {
    const file = path.join(dir, "export.zip");
    const { filename, manifest } = await writeExport(
      db,
      storage,
      run.workspaceId,
      createWriteStream(file, { flags: "w", mode: 0o600 }),
    );
    ctx.signal.throwIfAborted();
    const { sha256, size } = await sha256OfFile(file);
    const key = storageKeys.export(run.workspaceId, run.id);
    await storage.putObject(key, createReadStream(file), {
      contentType: "application/zip",
      contentLength: size,
      metadata: { sha256 },
    });
    const completedAt = new Date();
    await db
      .update(exportRuns)
      .set({
        status: "completed",
        storageKey: key,
        filename,
        byteSize: size,
        sha256,
        manifestSummary: {
          createdAt: manifest.createdAt,
          appVersion: manifest.appVersion,
          dbMigration: manifest.dbMigration,
          counts: manifest.counts,
        },
        completedAt,
        expiresAt: new Date(completedAt.getTime() + EXPORT_RETENTION_DAYS * 86_400_000),
      })
      .where(eq(exportRuns.id, run.id));
    return { exportId: run.id, byteSize: size, sha256, counts: manifest.counts };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function exportJobDefinition(timeoutMs: number): JobDefinition {
  return {
    type: EXPORT_JOB_TYPE,
    timeoutMs,
    handler: runExport,
    onFailed: async ({ job, db, failure }) => {
      await db
        .update(exportRuns)
        .set({
          status: "failed",
          errorMessage: `${failure.code}: ${failure.message}`.slice(0, 1000),
          completedAt: new Date(),
        })
        .where(
          and(
            eq(exportRuns.id, String(job.payload.exportId ?? "")),
            inArray(exportRuns.status, ["queued", "running"]),
          ),
        );
    },
  };
}

/**
 * Deletes expired export archives (called by the maintenance job). Idempotent. An object that
 * cannot be deleted does not stop the others; the call throws afterwards so the job reports it.
 */
export async function deleteExpiredExports(
  db: DbExecutor,
  storage: StorageAdapter,
  now = new Date(),
  options: { signal?: AbortSignal } = {},
): Promise<number> {
  return eachRowIndependently(
    (afterId, limit) =>
      db
        .select({ id: exportRuns.id, storageKey: exportRuns.storageKey })
        .from(exportRuns)
        .where(
          and(
            eq(exportRuns.status, "completed"),
            lt(exportRuns.expiresAt, now),
            sql`${exportRuns.storageKey} is not null`,
            afterId ? gt(exportRuns.id, afterId) : undefined,
          ),
        )
        .orderBy(exportRuns.id)
        .limit(limit),
    async (run) => {
      await storage.deleteObject(run.storageKey!);
      await db.update(exportRuns).set({ storageKey: null }).where(eq(exportRuns.id, run.id));
    },
    options,
  );
}

export function exportCleanupJobDefinition(): JobDefinition {
  return {
    type: EXPORT_CLEANUP_JOB_TYPE,
    timeoutMs: 10 * 60 * 1000,
    // The two phases run independently: a stuck export object must not starve restore cleanup.
    handler: async ({ db, storage, signal }) => {
      const now = new Date();
      const [exports, restores] = await Promise.allSettled([
        deleteExpiredExports(db, storage, now, { signal }),
        cleanupRestoreUploads(db, storage, now, { signal }),
      ]);
      if (exports.status === "rejected") throw exports.reason;
      if (restores.status === "rejected") throw restores.reason;
      return { deleted: exports.value, restoreUploadsDeleted: restores.value };
    },
  };
}
