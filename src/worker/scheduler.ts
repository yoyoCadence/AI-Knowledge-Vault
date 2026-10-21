import type { Database } from "@/infrastructure/database/client";
import type { Logger } from "@/infrastructure/observability/logger";
import { EXPORT_CLEANUP_JOB_TYPE, INTEGRITY_SCHEDULE_JOB_TYPE } from "@/modules/backup";
import { IMPORT_CLEANUP_JOB_TYPE } from "@/modules/imports";
import { enqueueJob } from "@/modules/jobs";
import { SEARCH_REINDEX_ALL_JOB_TYPE } from "@/modules/search";

/**
 * Periodic maintenance scheduling. Each period maps to one idempotency key
 * (`<type>:<bucket>`), so any number of worker processes enqueue each run exactly once.
 */
export const MAINTENANCE_JOBS = [
  { type: IMPORT_CLEANUP_JOB_TYPE, everyMs: 60 * 60 * 1000 },
  { type: EXPORT_CLEANUP_JOB_TYPE, everyMs: 60 * 60 * 1000 },
  // Weekly re-hash of every original in every workspace (BACKUP_RECOVERY §7).
  { type: INTEGRITY_SCHEDULE_JOB_TYPE, everyMs: 7 * 24 * 60 * 60 * 1000 },
  // Daily: index anything missing (backfill after deploy, permanently failed index jobs).
  { type: SEARCH_REINDEX_ALL_JOB_TYPE, everyMs: 24 * 60 * 60 * 1000 },
] as const;

export async function enqueueDueMaintenance(db: Database, now = new Date()): Promise<number> {
  let created = 0;
  for (const job of MAINTENANCE_JOBS) {
    const bucket = Math.floor(now.getTime() / job.everyMs);
    const result = await enqueueJob(db, {
      type: job.type,
      idempotencyKey: `${job.type}:${bucket}`,
      priority: -10,
    });
    if (result.created) created += 1;
  }
  return created;
}

/** Starts the scheduler loop; returns a stop function. */
export function startScheduler(db: Database, logger: Logger, tickMs = 5 * 60 * 1000): () => void {
  const tick = () =>
    enqueueDueMaintenance(db).catch((error: unknown) =>
      logger.error({ err: error }, "maintenance scheduling failed"),
    );
  void tick();
  const timer = setInterval(tick, tickMs);
  timer.unref();
  return () => clearInterval(timer);
}
