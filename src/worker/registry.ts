import type { Env } from "@/infrastructure/config/env";
import {
  exportCleanupJobDefinition,
  exportJobDefinition,
  integrityJobDefinition,
  integrityScheduleJobDefinition,
  reextractJobDefinition,
  restoreJobDefinition,
  restoreLimitsFromEnv,
} from "@/modules/backup";
import {
  importCleanupJobDefinition,
  importJobDefinition,
  processLimitsFromEnv,
} from "@/modules/imports";
import { JobRegistry } from "@/modules/jobs";
import { searchIndexJobDefinition, searchReindexAllJobDefinition } from "@/modules/search";

/**
 * All job types the worker executes. Each handler module documents why it is idempotent.
 */
export function buildJobRegistry(env: Env): JobRegistry {
  const limits = processLimitsFromEnv(env);
  return new JobRegistry()
    .register(importJobDefinition(limits, env.IMPORT_ITEM_TIMEOUT_MS))
    .register(importCleanupJobDefinition())
    .register(exportJobDefinition(env.EXPORT_JOB_TIMEOUT_MS))
    .register(exportCleanupJobDefinition())
    .register(reextractJobDefinition(limits, env.IMPORT_ITEM_TIMEOUT_MS))
    .register(integrityJobDefinition(env.EXPORT_JOB_TIMEOUT_MS))
    .register(
      restoreJobDefinition(
        { ...restoreLimitsFromEnv(env), maxArchiveBytes: env.RESTORE_MAX_ARCHIVE_BYTES },
        env.EXPORT_JOB_TIMEOUT_MS,
      ),
    )
    .register(integrityScheduleJobDefinition())
    .register(searchIndexJobDefinition())
    .register(searchReindexAllJobDefinition());
}
