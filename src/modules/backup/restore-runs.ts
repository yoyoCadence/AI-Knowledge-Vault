import { and, desc, eq, inArray } from "drizzle-orm";
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
import { restoreArchive, type RestoreLimits } from "./restore";

/**
 * Restore through the API (BACKUP_RECOVERY §6): declare an archive → upload it straight to
 * storage with a signed PUT → start → the `restore.run` job verifies and restores it with
 * `restoreArchive` → the run carries the report. The uploaded archive is deleted afterwards.
 */

export const RESTORE_JOB_TYPE = "restore.run";
const UPLOAD_TTL_SECONDS = 3600;

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
    started: run.jobId !== null,
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
  const head = current.sourceStorageKey ? await storage.headObject(current.sourceStorageKey) : null;
  if (!head) throw new AppError("UPLOAD_INCOMPLETE", "The backup archive has not been uploaded");
  if (head.size !== current.sourceByteSize) {
    throw new AppError("SIZE_MISMATCH", "Uploaded size does not match the declared size");
  }
  return db.transaction(async (tx) => {
    const run = await loadRun(tx, actor, id, true);
    if (run.jobId) return run;
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

async function finish(
  db: DbExecutor,
  storage: StorageAdapter,
  run: RestoreRun,
  patch: Partial<typeof restoreRuns.$inferInsert>,
) {
  await db
    .update(restoreRuns)
    .set({ ...patch, completedAt: new Date() })
    .where(eq(restoreRuns.id, run.id));
  // The uploaded archive is the owner's copy, not ours to keep.
  if (run.sourceStorageKey) await storage.deleteObject(run.sourceStorageKey);
}

/**
 * Job handler. Idempotent: finished runs are skipped, and `restoreArchive` is itself safe to
 * re-run (verify-before-write, content-addressed originals, deterministic ids). An archive that
 * is invalid (checksum mismatch, wrong format) fails the run with its details; transient errors
 * are retried by the queue.
 */
export async function runRestore(
  ctx: JobContext,
  limits: RestoreLimits & { maxArchiveBytes: number },
): Promise<Record<string, unknown>> {
  const { db, storage } = ctx;
  const restoreId = String(ctx.job.payload.restoreId ?? "");
  const [run] = await db.select().from(restoreRuns).where(eq(restoreRuns.id, restoreId));
  if (!run) return { skipped: "missing_run" };
  if (run.status === "completed" || run.status === "failed") return { skipped: run.status };
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
    });
    await finish(db, storage, run, { status: "completed", report: { ...report } });
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
