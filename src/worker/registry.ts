import { JobRegistry } from "@/modules/jobs";

/**
 * All job types the worker executes. Each handler module documents why it is idempotent.
 * Handlers are added as features land (see docs/ROADMAP.md).
 */
export function buildJobRegistry(): JobRegistry {
  return new JobRegistry();
}
