import type { ItemStatus } from "@/infrastructure/database/schema";

/**
 * Import item state machine (DATA_MODEL §4.3). Every status write goes through `canTransition`
 * so illegal jumps (e.g. succeeded → queued) are impossible by construction.
 */
const TRANSITIONS: Record<ItemStatus, readonly ItemStatus[]> = {
  awaiting_upload: ["uploaded", "queued", "cancelled", "expired", "failed"],
  uploaded: ["queued", "cancelled", "expired", "failed"],
  queued: ["processing", "cancelled", "failed"],
  processing: ["succeeded", "duplicate", "failed", "queued"],
  failed: ["queued"],
  succeeded: [],
  duplicate: [],
  cancelled: [],
  expired: [],
};

export const TERMINAL_STATUSES: readonly ItemStatus[] = [
  "succeeded",
  "duplicate",
  "failed",
  "cancelled",
  "expired",
];

export function canTransition(from: ItemStatus, to: ItemStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: ItemStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
