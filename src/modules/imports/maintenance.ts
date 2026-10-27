import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "@/infrastructure/database/client";
import { importItems, processingJobs } from "@/infrastructure/database/schema";
import type { StorageAdapter } from "@/infrastructure/storage";
import type { JobDefinition } from "@/modules/jobs";
import { IMPORT_JOB_TYPE, refreshBatchStatus, transitionItem } from "./service";

/**
 * Import housekeeping (IMPORT_PIPELINE §8, P1A-RECOVERY). Safe to run any time and concurrently:
 * every step re-checks state under row locks and every storage delete is idempotent.
 *
 * 1. Expire uploads that were declared but never completed.
 * 2. Reconcile items whose job ended (failed/cancelled, e.g. lease expired with no attempts
 *    left) without the item being updated — they would otherwise stay "processing" forever.
 * 3. Delete staged upload bytes once they are no longer needed (terminal items after a grace
 *    period; failed items are kept longer so they can still be retried).
 * 4. Prune old finished job rows so the queue table stays small.
 */
export const IMPORT_CLEANUP_JOB_TYPE = "maintenance.cleanup_imports";
/** How long finished job rows are kept; failed and cancelled ones go by their last update. */
export const JOB_RETENTION_DAYS = { completed: 30, failed: 90 } as const;

export interface CleanupOptions {
  now?: Date;
  uploadGraceMs?: number;
  terminalRetentionMs?: number;
  failedRetentionMs?: number;
  completedJobRetentionMs?: number;
  failedJobRetentionMs?: number;
  batchSize?: number;
}

export interface CleanupReport {
  expired: number;
  reconciled: number;
  stagingDeleted: number;
  jobsPruned: number;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export async function cleanupImports(
  db: Database,
  storage: StorageAdapter,
  options: CleanupOptions = {},
): Promise<CleanupReport> {
  const now = options.now ?? new Date();
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const limit = options.batchSize ?? 500;
  const report: CleanupReport = { expired: 0, reconciled: 0, stagingDeleted: 0, jobsPruned: 0 };

  // 1. Expire abandoned uploads.
  const stale = await db
    .select({ id: importItems.id })
    .from(importItems)
    .where(
      and(
        inArray(importItems.status, ["awaiting_upload", "uploaded"]),
        lt(importItems.uploadExpiresAt, ago(options.uploadGraceMs ?? HOUR)),
      ),
    )
    .limit(limit);
  for (const { id } of stale) {
    await db.transaction(async (tx) => {
      const [item] = await tx
        .select()
        .from(importItems)
        .where(eq(importItems.id, id))
        .for("update");
      if (!item || !["awaiting_upload", "uploaded"].includes(item.status)) return;
      await transitionItem(tx, item, "expired", {
        errorCode: "UPLOAD_EXPIRED",
        errorMessage: "The upload was never completed before its upload URL expired",
        completedAt: now,
      });
      await refreshBatchStatus(tx, item.batchId);
      report.expired += 1;
    });
  }

  // 2. Reconcile items whose job ended without updating them.
  const orphaned = await db
    .select({
      id: importItems.id,
      errorCode: processingJobs.errorCode,
      lastError: processingJobs.lastError,
    })
    .from(importItems)
    .innerJoin(
      processingJobs,
      eq(processingJobs.idempotencyKey, sql`${IMPORT_JOB_TYPE} || ':' || ${importItems.id}::text`),
    )
    .where(
      and(
        inArray(importItems.status, ["queued", "processing"]),
        inArray(processingJobs.status, ["failed", "cancelled"]),
      ),
    )
    .limit(limit);
  for (const row of orphaned) {
    await db.transaction(async (tx) => {
      const [item] = await tx
        .select()
        .from(importItems)
        .where(eq(importItems.id, row.id))
        .for("update");
      if (!item || !["queued", "processing"].includes(item.status)) return;
      await transitionItem(tx, item, "failed", {
        errorCode: row.errorCode ?? "JOB_FAILED",
        errorMessage: (row.lastError ?? "processing stopped before completion").slice(0, 1000),
        completedAt: now,
      });
      await refreshBatchStatus(tx, item.batchId);
      report.reconciled += 1;
    });
  }

  // 3. Delete staged bytes that are no longer needed.
  const cleanable = await db
    .select({ id: importItems.id, stagingKey: importItems.stagingKey })
    .from(importItems)
    .where(
      and(
        isNull(importItems.stagingCleanedAt),
        or(
          and(
            inArray(importItems.status, ["succeeded", "duplicate", "cancelled", "expired"]),
            lt(importItems.updatedAt, ago(options.terminalRetentionMs ?? DAY)),
          ),
          and(
            eq(importItems.status, "failed"),
            lt(importItems.updatedAt, ago(options.failedRetentionMs ?? 7 * DAY)),
          ),
        ),
      ),
    )
    .limit(limit);
  for (const row of cleanable) {
    await storage.deleteObject(row.stagingKey);
    await db.update(importItems).set({ stagingCleanedAt: now }).where(eq(importItems.id, row.id));
    report.stagingDeleted += 1;
  }

  // 4. Prune finished job rows (the domain tables keep the durable record).
  const pruned = await db
    .delete(processingJobs)
    .where(
      or(
        and(
          eq(processingJobs.status, "completed"),
          lt(
            processingJobs.completedAt,
            ago(options.completedJobRetentionMs ?? JOB_RETENTION_DAYS.completed * DAY),
          ),
        ),
        and(
          inArray(processingJobs.status, ["failed", "cancelled"]),
          lt(
            processingJobs.updatedAt,
            ago(options.failedJobRetentionMs ?? JOB_RETENTION_DAYS.failed * DAY),
          ),
        ),
      ),
    )
    .returning({ id: processingJobs.id });
  report.jobsPruned = pruned.length;

  return report;
}

export function importCleanupJobDefinition(): JobDefinition {
  return {
    type: IMPORT_CLEANUP_JOB_TYPE,
    timeoutMs: 10 * 60 * 1000,
    handler: async ({ db, storage }) => ({ ...(await cleanupImports(db, storage)) }),
  };
}
