import type { importBatches, importItems } from "@/infrastructure/database/schema";
import { isRetryable } from "./service";

/** API representations: internal fields (storage keys, workspace ids) never leave the server. */
export function toItemDto(
  item: typeof importItems.$inferSelect & { resultArtifactTitle?: string | null },
) {
  return {
    id: item.id,
    batchId: item.batchId,
    clientKey: item.clientKey,
    filename: item.originalFilename,
    declaredSize: item.declaredSize,
    status: item.status,
    outcome: item.outcome,
    matchReason: item.matchReason,
    detectedType: item.detectedType,
    sha256: item.sha256,
    resultArtifactId: item.resultArtifactId,
    resultVersionId: item.resultVersionId,
    resultArtifactTitle: item.resultArtifactTitle ?? null,
    suspectedDuplicateOf: item.suspectedDuplicateOf,
    targetArtifactId: item.targetArtifactId,
    errorCode: item.errorCode,
    errorMessage: item.errorMessage,
    retryable: isRetryable(item),
    warnings: item.warnings,
    uploadExpiresAt: item.uploadExpiresAt,
    createdAt: item.createdAt,
    completedAt: item.completedAt,
  };
}

export function toBatchDto(batch: typeof importBatches.$inferSelect) {
  return {
    id: batch.id,
    status: batch.status,
    targetProjectId: batch.targetProjectId,
    options: batch.options,
    createdAt: batch.createdAt,
    completedAt: batch.completedAt,
  };
}
