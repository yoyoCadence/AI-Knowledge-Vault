import { and, eq } from "drizzle-orm";
import type { DbExecutor } from "@/infrastructure/database/client";
import {
  artifactVersions,
  derivedAssets,
  extractedDocuments,
  fileAssets,
} from "@/infrastructure/database/schema";
import { AppError } from "@/lib/errors";
import { contentHash, sniffFormat } from "@/modules/extraction";
import { downloadToTempFile } from "@/modules/files/staging";
import { deriveVersionContent, saveExtraction } from "@/modules/imports/derive";
import type { ProcessLimits } from "@/modules/imports";
import type { JobContext, JobDefinition } from "@/modules/jobs";
import { REEXTRACT_JOB_TYPE, RESTORE_EXTRACTION_METHOD } from "./restore";

/**
 * `restore.reextract_version` (BACKUP_RECOVERY §6 step 7): rebuilds a restored version's
 * extraction, sections, thumbnail and preview files from its original, with exactly the code
 * the import pipeline uses.
 *
 * Idempotency: the version row is locked when committing, and a version whose active
 * extraction is no longer the archived fallback has already been rebuilt, so a re-run is a
 * no-op. Derived objects use deterministic ids (re-writing them is harmless) and their rows are
 * inserted with ON CONFLICT DO NOTHING.
 *
 * Failure keeps the archived Markdown as the active text; only `processing_status` says
 * `failed`, so the restored content stays readable.
 */

async function activeMethod(db: DbExecutor, extractionId: string | null): Promise<string | null> {
  if (!extractionId) return null;
  const [row] = await db
    .select({ method: extractedDocuments.extractionMethod })
    .from(extractedDocuments)
    .where(eq(extractedDocuments.id, extractionId));
  return row?.method ?? null;
}

const alreadyRebuilt = (version: { processingStatus: string }, method: string | null) =>
  version.processingStatus === "ready" && method !== RESTORE_EXTRACTION_METHOD;

export async function reextractVersion(
  ctx: JobContext,
  limits: ProcessLimits,
): Promise<Record<string, unknown>> {
  const { db, storage, signal } = ctx;
  const versionId = String(ctx.job.payload.versionId ?? "");
  const [version] = await db
    .select()
    .from(artifactVersions)
    .where(eq(artifactVersions.id, versionId));
  if (!version) return { skipped: "missing_version" };
  if (ctx.job.workspaceId && version.workspaceId !== ctx.job.workspaceId) {
    throw new AppError("FORBIDDEN", "job workspace does not match version workspace");
  }
  if (alreadyRebuilt(version, await activeMethod(db, version.activeExtractionId))) {
    return { skipped: "already_rebuilt" };
  }
  const [asset] = await db
    .select()
    .from(fileAssets)
    .where(
      and(
        eq(fileAssets.id, version.primaryFileId),
        eq(fileAssets.workspaceId, version.workspaceId),
      ),
    );
  if (!asset) throw new AppError("NOT_FOUND", "primary file of the version is missing");

  const staged = await downloadToTempFile(storage, asset.storageKey, {
    maxBytes: limits.maxFileBytes,
    signal,
  });
  try {
    if (staged.sha256 !== asset.sha256) {
      throw new AppError("ORIGINAL_CORRUPT", "stored original does not match its SHA-256", {
        retryable: false,
      });
    }
    const sniff = sniffFormat(staged.head, asset.originalFilename);
    if (sniff.format === "unknown") {
      throw new AppError("UNSUPPORTED_FILE_TYPE", "The original is not a supported format");
    }
    const { extraction, classification, derived, rejection } = await deriveVersionContent({
      storage,
      workspaceId: version.workspaceId,
      versionId,
      filePath: staged.path,
      filename: asset.originalFilename,
      size: staged.size,
      sha256: staged.sha256,
      format: sniff.format,
      limits,
      signal,
    });

    return await db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(artifactVersions)
        .where(eq(artifactVersions.id, versionId))
        .for("update");
      if (!locked) return { skipped: "missing_version" };
      if (alreadyRebuilt(locked, await activeMethod(tx, locked.activeExtractionId))) {
        return { skipped: "already_rebuilt" };
      }
      if (derived.length > 0) {
        await tx.insert(derivedAssets).values(derived).onConflictDoNothing();
      }
      const failed = extraction.status === "failed";
      // A failed re-extraction never hides the archived text that is already readable.
      if (!failed || !locked.activeExtractionId) {
        await saveExtraction(tx, { workspaceId: version.workspaceId, versionId, extraction });
      }
      const previewKind = rejection ? "unsupported" : classification.previewKind;
      await tx
        .update(artifactVersions)
        .set({
          previewKind,
          previewEntryPath: rejection ? null : classification.previewEntryPath,
          previewStatus: previewKind === "unsupported" ? "unavailable" : "ready",
          // Same rule as imports: a rejected archive keeps a readable extraction and is "ready";
          // only the preview becomes unavailable.
          processingStatus: failed ? "failed" : "ready",
          contentHash:
            !failed && extraction.plainText
              ? contentHash(extraction.plainText)
              : locked.contentHash,
          updatedAt: new Date(),
        })
        .where(eq(artifactVersions.id, versionId));
      return {
        versionId,
        status: failed ? "failed" : "ready",
        derived: derived.length,
        ...(rejection ? { rejection: rejection.code } : {}),
      };
    });
  } finally {
    await staged.cleanup();
  }
}

/** Marks the version failed (keeping any archived fallback text) when the job gives up. */
async function markVersionFailed(db: DbExecutor, versionId: string) {
  await db
    .update(artifactVersions)
    .set({ processingStatus: "failed", previewStatus: "failed", updatedAt: new Date() })
    .where(
      and(eq(artifactVersions.id, versionId), eq(artifactVersions.processingStatus, "pending")),
    );
}

export function reextractJobDefinition(limits: ProcessLimits, timeoutMs: number): JobDefinition {
  return {
    type: REEXTRACT_JOB_TYPE,
    timeoutMs,
    handler: (ctx) => reextractVersion(ctx, limits),
    onFailed: ({ job, db }) => markVersionFailed(db, String(job.payload.versionId ?? "")),
  };
}
