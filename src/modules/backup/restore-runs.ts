import { and, desc, eq, gt, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { z } from "zod";
import type { Database, DbExecutor } from "@/infrastructure/database/client";
import { RESTORE_MODES, restoreRuns } from "@/infrastructure/database/schema";
import { storageKeys, type SignedRequest, type StorageAdapter } from "@/infrastructure/storage";
import { AppError, isAppError, notFound } from "@/lib/errors";
import { newId } from "@/lib/ids";
import { recordAudit, type RequestMeta } from "@/modules/audit";
import type { Actor } from "@/modules/auth";
import { downloadToTempFile } from "@/modules/files/staging";
import { enqueueJob, type JobContext, type JobDefinition } from "@/modules/jobs";
import { eachRowIndependently } from "./each-independently";
import { restoreArchive, type RestoreLimits } from "./restore";

/**
 * Restore through the API (BACKUP_RECOVERY §6): declare an archive → upload it straight to
 * storage with a signed PUT → start → the `restore.run` job verifies and restores it with
 * `restoreArchive` → the run carries the report. The uploaded archive is deleted afterwards;
 * `sourceStorageKey` is cleared only once that succeeded, so `cleanupRestoreUploads` (hourly
 * maintenance) can finish any deletion that failed, and also removes uploads never started.
 */

export const RESTORE_JOB_TYPE = "restore.run";
const UPLOAD_TTL_SECONDS = 3600;
/** An upload not started within this long is abandoned: the run fails, the archive is deleted. */
export const ABANDONED_RESTORE_AFTER_MS = 24 * 60 * 60 * 1000;

export type RestoreRun = typeof restoreRuns.$inferSelect;

export const CreateRestoreInput = z.object({
  filename: z.string().trim().min(1).max(255),
  size: z.number().int().positive(),
});
export const StartRestoreInput = z.object({
  mode: z.enum(RESTORE_MODES).default("skip_existing"),
});

export function toRestoreDto(run: RestoreRun) {
  return {
    id: run.id,
    status: run.status,
    mode: run.mode,
    filename: run.sourceFilename,
    byteSize: run.sourceByteSize,
    sha256: run.sourceSha256,
    // From the durable status: the job row (and so jobId) is pruned 30 days after it ends.
    started: run.jobId !== null || run.status !== "queued",
    report: run.report,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
  };
}

async function loadRun(db: DbExecutor, actor: Actor, id: string, lock = false) {
  const query = db
    .select()
    .from(restoreRuns)
    .where(and(eq(restoreRuns.id, id), eq(restoreRuns.workspaceId, actor.workspaceId)));
  const [run] = lock ? await query.for("update") : await query;
  if (!run) throw notFound("Restore");
  return run;
}

export async function createRestore(
  db: Database,
  storage: StorageAdapter,
  actor: Actor,
  input: z.infer<typeof CreateRestoreInput>,
  options: { maxArchiveBytes: number; meta: RequestMeta },
): Promise<{ run: RestoreRun; upload: SignedRequest }> {
  if (input.size > options.maxArchiveBytes) {
    throw new AppError(
      "PAYLOAD_TOO_LARGE",
      `Backup archives are limited to ${options.maxArchiveBytes} bytes`,
    );
  }
  const id = newId();
  const key = storageKeys.restoreUpload(actor.workspaceId, id);
  const [run] = await db
    .insert(restoreRuns)
    .values({
      id,
      workspaceId: actor.workspaceId,
      requestedBy: actor.userId,
      status: "queued",
      sourceStorageKey: key,
      sourceFilename: input.filename,
      sourceByteSize: input.size,
    })
    .returning();
  await recordAudit(db, {
    action: "backup.restore.requested",
    workspaceId: actor.workspaceId,
    actorUserId: actor.userId,
    targetType: "restore_run",
    targetId: id,
    metadata: { filename: input.filename, size: input.size },
    ...options.meta,
  });
  const upload = await storage.createSignedUploadUrl(key, {
    contentLength: input.size,
    contentType: "application/zip",
    expiresInSeconds: UPLOAD_TTL_SECONDS,
  });
  return { run: run!, upload };
}

/** Queues the restore once the archive is uploaded. Idempotent for an already started run. */
export async function startRestore(
  db: Database,
  storage: StorageAdapter,
  actor: Actor,
  id: string,
  input: z.infer<typeof StartRestoreInput>,
  meta: RequestMeta,
): Promise<RestoreRun> {
  const current = await loadRun(db, actor, id);
  if (current.jobId) return current;
  assertStartable(current);
  const head = current.sourceStorageKey ? await storage.headObject(current.sourceStorageKey) : null;
  if (!head) throw new AppError("UPLOAD_INCOMPLETE", "The backup archive has not been uploaded");
  if (head.size !== current.sourceByteSize) {
    throw new AppError("SIZE_MISMATCH", "Uploaded size does not match the declared size");
  }
  return db.transaction(async (tx) => {
    const run = await loadRun(tx, actor, id, true);
    if (run.jobId) return run;
    assertStartable(run);
    const { job } = await enqueueJob(tx, {
      type: RESTORE_JOB_TYPE,
      idempotencyKey: `${RESTORE_JOB_TYPE}:${run.id}`,
      workspaceId: run.workspaceId,
      payload: { restoreId: run.id },
      maxAttempts: 3,
    });
    const [updated] = await tx
      .update(restoreRuns)
      .set({ mode: input.mode, jobId: job.id })
      .where(eq(restoreRuns.id, run.id))
      .returning();
    await recordAudit(tx, {
      action: "backup.restore.started",
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      targetType: "restore_run",
      targetId: run.id,
      metadata: { mode: input.mode },
      ...meta,
    });
    return updated!;
  });
}

/** A run that ended without starting (abandoned upload) can never start later. */
function assertStartable(run: RestoreRun) {
  if (run.status !== "queued" || !run.sourceStorageKey) {
    throw new AppError("NOT_RETRYABLE", "This restore has ended; upload the archive again");
  }
}

export async function getRestore(db: DbExecutor, actor: Actor, id: string) {
  return loadRun(db, actor, id);
}

export async function listRestores(db: DbExecutor, actor: Actor, limit = 10) {
  return db
    .select()
    .from(restoreRuns)
    .where(eq(restoreRuns.workspaceId, actor.workspaceId))
    .orderBy(desc(restoreRuns.createdAt))
    .limit(limit);
}

/**
 * Deletes a run's uploaded archive (the owner's copy, not ours to keep), then forgets its key.
 * A failed deletion keeps the key, so a job retry or the maintenance sweep tries again.
 */
async function releaseUpload(
  db: DbExecutor,
  storage: StorageAdapter,
  run: Pick<RestoreRun, "id" | "sourceStorageKey">,
) {
  if (!run.sourceStorageKey) return;
  await storage.deleteObject(run.sourceStorageKey);
  await db.update(restoreRuns).set({ sourceStorageKey: null }).where(eq(restoreRuns.id, run.id));
}

async function finish(
  db: DbExecutor,
  storage: StorageAdapter,
  run: RestoreRun,
  patch: Partial<typeof restoreRuns.$inferInsert>,
) {
  // Only while still running: an attempt that outlived its timeout must not overwrite the
  // failure that onFailed already recorded.
  await db
    .update(restoreRuns)
    .set({ ...patch, completedAt: new Date() })
    .where(and(eq(restoreRuns.id, run.id), eq(restoreRuns.status, "running")));
  await releaseUpload(db, storage, run);
}

/**
 * Job handler. Idempotent: finished runs only finish deleting their upload, and
 * `restoreArchive` is itself safe to re-run (verify-before-write, content-addressed originals,
 * ids derived from the run in both modes). An archive that is invalid (checksum mismatch, wrong
 * format) fails the run with its details; transient errors are retried by the queue. The job's
 * abort signal reaches `restoreArchive`, so a timed-out attempt stops writing.
 */
export async function runRestore(
  ctx: JobContext,
  limits: RestoreLimits & { maxArchiveBytes: number },
): Promise<Record<string, unknown>> {
  const { db, storage } = ctx;
  const restoreId = String(ctx.job.payload.restoreId ?? "");
  const [run] = await db.select().from(restoreRuns).where(eq(restoreRuns.id, restoreId));
  if (!run) return { skipped: "missing_run" };
  if (run.status === "completed" || run.status === "failed") {
    await releaseUpload(db, storage, run);
    return { skipped: run.status };
  }
  if (!run.sourceStorageKey) throw new AppError("UPLOAD_INCOMPLETE", "No archive for this run");
  await db.update(restoreRuns).set({ status: "running" }).where(eq(restoreRuns.id, run.id));

  const staged = await downloadToTempFile(storage, run.sourceStorageKey, {
    maxBytes: limits.maxArchiveBytes,
    signal: ctx.signal,
  });
  try {
    await db
      .update(restoreRuns)
      .set({ sourceSha256: staged.sha256 })
      .where(eq(restoreRuns.id, run.id));
    const report = await restoreArchive(db, storage, {
      archivePath: staged.path,
      workspaceId: run.workspaceId,
      userId: run.requestedBy,
      mode: run.mode,
      restoreId: run.id,
      limits,
      signal: ctx.signal,
    });
    // Each attempt reports what it saw. What an interrupted earlier attempt of this run wrote
    // is already in place and is counted differently per mode: say so instead of guessing.
    const attempt = ctx.job.attemptCount;
    if (attempt > 1) {
      const earlier =
        run.mode === "copy"
          ? "originals an earlier, interrupted attempt of this run stored are counted as reused; the copies it made are counted as copied"
          : "rows an earlier, interrupted attempt of this run wrote are counted as skipped (projects, artifacts, versions) or reused (originals)";
      report.warnings.unshift(`RETRIED_RUN: this run took ${attempt} attempts; ${earlier}`);
    }
    await finish(db, storage, run, { status: "completed", report: { ...report, attempt } });
    return { restoreId: run.id, counts: report.counts };
  } catch (error) {
    if (isAppError(error) && !error.retryable) {
      await finish(db, storage, run, {
        status: "failed",
        errorCode: error.code,
        errorMessage: error.message.slice(0, 1000),
        report: error.details ? { details: error.details } : null,
      });
      return { restoreId: run.id, failed: error.code };
    }
    throw error;
  } finally {
    await staged.cleanup();
  }
}

export function restoreJobDefinition(
  limits: RestoreLimits & { maxArchiveBytes: number },
  timeoutMs: number,
): JobDefinition {
  return {
    type: RESTORE_JOB_TYPE,
    timeoutMs,
    handler: (ctx) => runRestore(ctx, limits),
    onFailed: async ({ job, db, failure }) => {
      await db
        .update(restoreRuns)
        .set({
          status: "failed",
          errorCode: failure.code,
          errorMessage: failure.message.slice(0, 1000),
          completedAt: new Date(),
        })
        .where(
          and(
            eq(restoreRuns.id, String(job.payload.restoreId ?? "")),
            inArray(restoreRuns.status, ["queued", "running"]),
          ),
        );
    },
  };
}

/**
 * Maintenance (hourly, with the export cleanup). Fails runs whose archive was uploaded but never
 * started within ABANDONED_RESTORE_AFTER_MS, then deletes the archives of every ended run that
 * still holds one (abandoned, or a deletion that failed). Idempotent; returns archives deleted.
 */
export async function cleanupRestoreUploads(
  db: DbExecutor,
  storage: StorageAdapter,
  now = new Date(),
  options: { pageSize?: number } = {},
): Promise<number> {
  // Conditional on the row still being unstarted: startRestore locks the same row, so a run is
  // either started or abandoned, never both.
  await db
    .update(restoreRuns)
    .set({
      status: "failed",
      errorCode: "UPLOAD_INCOMPLETE",
      errorMessage: "The restore was never started; the uploaded archive was deleted",
      completedAt: now,
    })
    .where(
      and(
        eq(restoreRuns.status, "queued"),
        isNull(restoreRuns.jobId),
        isNotNull(restoreRuns.sourceStorageKey),
        lt(restoreRuns.createdAt, new Date(now.getTime() - ABANDONED_RESTORE_AFTER_MS)),
      ),
    );
  return eachRowIndependently(
    (afterId, limit) =>
      db
        .select({ id: restoreRuns.id, sourceStorageKey: restoreRuns.sourceStorageKey })
        .from(restoreRuns)
        .where(
          and(
            inArray(restoreRuns.status, ["completed", "failed"]),
            isNotNull(restoreRuns.sourceStorageKey),
            afterId ? gt(restoreRuns.id, afterId) : undefined,
          ),
        )
        .orderBy(restoreRuns.id)
        .limit(limit),
    (run) => releaseUpload(db, storage, run),
    options.pageSize,
  );
}
