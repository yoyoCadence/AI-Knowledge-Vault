import type { DbExecutor } from "@/infrastructure/database/client";
import type { SignedRequest, StorageAdapter } from "@/infrastructure/storage";
import { recordAudit, type RequestMeta } from "@/modules/audit";
import type { Actor } from "@/modules/auth";
import { getVersionWithOriginal } from "./queries";

export const ORIGINAL_DOWNLOAD_TTL_SECONDS = 300;

/**
 * Authorizes and audits an original download, returning a short-lived signed URL bound to the one
 * object (FR-FILE-2, SECURITY.md §9). The URL forces `Content-Disposition: attachment`.
 */
export async function createOriginalDownload(
  db: DbExecutor,
  storage: StorageAdapter,
  actor: Actor,
  input: { artifactId: string; versionId: string },
  meta: RequestMeta,
): Promise<SignedRequest & { filename: string; sha256: string; byteSize: number }> {
  const { file } = await getVersionWithOriginal(db, actor, input.artifactId, input.versionId);
  const signed = await storage.createSignedDownloadUrl(file.storageKey, {
    expiresInSeconds: ORIGINAL_DOWNLOAD_TTL_SECONDS,
    filename: file.originalFilename,
    contentType: file.mimeType,
  });
  await recordAudit(db, {
    action: "artifact.original.downloaded",
    workspaceId: actor.workspaceId,
    actorUserId: actor.userId,
    targetType: "artifact_version",
    targetId: input.versionId,
    metadata: { fileAssetId: file.id, sha256: file.sha256 },
    ...meta,
  });
  return {
    ...signed,
    filename: file.originalFilename,
    sha256: file.sha256,
    byteSize: file.byteSize,
  };
}
