import type { Env } from "@/infrastructure/config/env";
import { importJobDefinition, processLimitsFromEnv } from "@/modules/imports";
import { JobRegistry } from "@/modules/jobs";

/**
 * All job types the worker executes. Each handler module documents why it is idempotent.
 */
export function buildJobRegistry(env: Env): JobRegistry {
  return new JobRegistry().register(
    importJobDefinition(processLimitsFromEnv(env), env.IMPORT_ITEM_TIMEOUT_MS),
  );
}
