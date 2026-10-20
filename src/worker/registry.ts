import type { Env } from "@/infrastructure/config/env";
import {
  exportCleanupJobDefinition,
  exportJobDefinition,
  integrityJobDefinition,
  integrityScheduleJobDefinition,
  reextractJobDefinition,
} from "@/modules/backup";
import {
  importCleanupJobDefinition,
  importJobDefinition,
  processLimitsFromEnv,
} from "@/modules/imports";
import { JobRegistry } from "@/modules/jobs";

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
    .register(integrityScheduleJobDefinition());
}
