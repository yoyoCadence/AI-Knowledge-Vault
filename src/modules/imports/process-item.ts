import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import type { DbExecutor } from "@/infrastructure/database/client";
import {
  artifactFiles,
  artifacts,
  artifactVersions,
  derivedAssets,
  fileAssets,
  importBatches,
  importItems,
  type MatchReason,
} from "@/infrastructure/database/schema";
import { StorageObjectNotFoundError } from "@/infrastructure/storage";
import { AppError } from "@/lib/errors";
import { identityKeyFor, isDistinctiveKey } from "@/modules/artifacts";
import {
  contentHash,
  fileExtension,
  filenameStem,
  sniffFormat,
  type ArchiveLimits,
  type ExtractionResult,
} from "@/modules/extraction";
import { downloadToTempFile } from "@/modules/files/staging";
import { storeOriginal } from "@/modules/files/originals";
import type { JobContext, JobDefinition } from "@/modules/jobs";
import { isTerminal } from "./state";
import { deriveVersionContent, deterministicId, saveExtraction } from "./derive";
import { IMPORT_JOB_TYPE, refreshBatchStatus, transitionItem } from "./service";

export { deterministicId };

/**
 * Worker handler for `import.process_item` (IMPORT_PIPELINE §1 stages 7–18).
 *
 * Idempotency (ADR-005: handlers must tolerate re-runs):
 * - The item row is the source of truth: terminal items are skipped; the commit transaction
 *   re-checks the status under a row lock, so two runs can never both commit.
 * - Originals are content-addressed with conditional writes (re-storing is a verified no-op).
 * - Version, artifact and derived-asset ids are derived deterministically from the item id
 *   (UUIDv5), so a crashed attempt's derived objects are overwritten — not duplicated — by the retry.
 * - Same-hash detection runs under a per-(workspace, sha256) advisory lock.
 */

export interface ProcessLimits extends ArchiveLimits {
  maxFileBytes: number;
}

type ItemRow = typeof importItems.$inferSelect;

/** Live (non-deleted) usage of an original with this content in the workspace, if any. */
async function findLiveUsage(db: DbExecutor, workspaceId: string, sha256: string) {
  const [row] = await db
    .select({
      fileAssetId: fileAssets.id,
      versionId: artifactVersions.id,
      artifactId: artifacts.id,
    })
    .from(fileAssets)
    .innerJoin(
      artifactFiles,
      and(eq(artifactFiles.fileAssetId, fileAssets.id), eq(artifactFiles.role, "original")),
    )
    .innerJoin(artifactVersions, eq(artifactVersions.id, artifactFiles.artifactVersionId))
    .innerJoin(
      artifacts,
      and(eq(artifacts.id, artifactVersions.artifactId), isNull(artifacts.deletedAt)),
    )
    .where(and(eq(fileAssets.workspaceId, workspaceId), eq(fileAssets.sha256, sha256)))
    .orderBy(desc(artifactVersions.createdAt))
    .limit(1);
  return row ?? null;
}

/** Version matching (IMPORT_PIPELINE §6): explicit target, else a unique distinctive filename match. */
async function resolveTarget(
  db: DbExecutor,
  item: ItemRow,
  identityKey: string,
  autoVersion: boolean,
): Promise<
  | { artifactId: string; reason: MatchReason }
  | { artifactId: null; reason: null; ambiguous: boolean }
> {
  if (item.targetArtifactId) {
    const [target] = await db
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.id, item.targetArtifactId),
          eq(artifacts.workspaceId, item.workspaceId),
          isNull(artifacts.deletedAt),
        ),
      );
    if (!target) throw new AppError("NOT_FOUND", "The target artifact no longer exists");
    return { artifactId: target.id, reason: "explicit_target" };
  }
  if (!autoVersion || !isDistinctiveKey(identityKey))
    return { artifactId: null, reason: null, ambiguous: false };
  const matches = await db
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.workspaceId, item.workspaceId),
        eq(artifacts.identityKey, identityKey),
        isNull(artifacts.deletedAt),
      ),
    )
    .limit(2);
  if (matches.length === 1) return { artifactId: matches[0]!.id, reason: "filename_stem" };
  return { artifactId: null, reason: null, ambiguous: matches.length > 1 };
}

function summarize(extraction: ExtractionResult, description: string | undefined): string | null {
  if (description) return description.slice(0, 280);
  const lines = extraction.plainText.split("\n").map((line) => line.trim());
  const first = lines.find((line) => line.length >= 20 && line !== extraction.title);
  if (!first) return null;
  return first.length > 280 ? `${first.slice(0, 279)}…` : first;
}

async function markDuplicate(
  db: DbExecutor,
  item: ItemRow,
  usage: { fileAssetId: string; versionId: string; artifactId: string },
  extra: { sha256: string; detectedType: string },
) {
  await transitionItem(db, item, "duplicate", {
    outcome: "duplicate_file",
    matchReason: "same_hash",
    fileAssetId: usage.fileAssetId,
    resultArtifactId: usage.artifactId,
    resultVersionId: usage.versionId,
    sha256: extra.sha256,
    detectedType: extra.detectedType,
    completedAt: new Date(),
  });
  await refreshBatchStatus(db, item.batchId);
}

export async function processImportItem(
  ctx: JobContext,
  limits: ProcessLimits,
): Promise<Record<string, unknown>> {
  const { db, storage, logger, signal } = ctx;
  const itemId = String(ctx.job.payload.itemId ?? "");
  const [initial] = await db.select().from(importItems).where(eq(importItems.id, itemId));
  if (!initial) return { skipped: "missing_item" };
  if (ctx.job.workspaceId && initial.workspaceId !== ctx.job.workspaceId) {
    throw new AppError("FORBIDDEN", "job workspace does not match item workspace");
  }
  if (isTerminal(initial.status)) return { skipped: initial.status };

  let item =
    initial.status === "queued" ? await transitionItem(db, initial, "processing") : initial;
  const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, item.batchId));
  if (!batch) return { skipped: "missing_batch" };

  let staged;
  try {
    staged = await downloadToTempFile(storage, item.stagingKey, {
      maxBytes: limits.maxFileBytes,
      signal,
    });
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) {
      throw new AppError("UPLOAD_INCOMPLETE", "The uploaded file is missing from staging storage");
    }
    throw error;
  }

  try {
    if (staged.size !== item.declaredSize) {
      throw new AppError(
        "SIZE_MISMATCH",
        `received ${staged.size} bytes but ${item.declaredSize} were declared`,
      );
    }
    const sniff = sniffFormat(staged.head, item.originalFilename);
    if (sniff.format === "unknown") {
      throw new AppError("UNSUPPORTED_FILE_TYPE", "The file content is not a supported format");
    }
    const warnings: string[] = [];
    const extension = fileExtension(item.originalFilename);
    const expectedByExtension: Record<string, string[]> = {
      zip: ["zip"],
      pdf: ["pdf"],
      png: ["png"],
      jpg: ["jpeg"],
      jpeg: ["jpeg"],
      webp: ["webp"],
    };
    if (expectedByExtension[extension] && !expectedByExtension[extension]!.includes(sniff.format)) {
      warnings.push(
        `CONTENT_TYPE_MISMATCH: .${extension} file contains ${sniff.format} data; treated as ${sniff.format}`,
      );
    }
    const detectedType = sniff.format;

    // Fast path: identical bytes already live in this workspace → nothing new to store.
    const existingUsage = await findLiveUsage(db, item.workspaceId, staged.sha256);
    if (existingUsage) {
      await db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(importItems)
          .where(eq(importItems.id, item.id))
          .for("update");
        if (!locked || locked.status !== "processing") return;
        await markDuplicate(tx, locked, existingUsage, { sha256: staged.sha256, detectedType });
      });
      await storage
        .deleteObject(item.stagingKey)
        .then(() =>
          db
            .update(importItems)
            .set({ stagingCleanedAt: new Date() })
            .where(eq(importItems.id, item.id)),
        )
        .catch(() => undefined);
      return { outcome: "duplicate_file", artifactId: existingUsage.artifactId };
    }

    const { storageKey } = await storeOriginal(storage, {
      workspaceId: item.workspaceId,
      sha256: staged.sha256,
      size: staged.size,
      mimeType: sniff.mimeType,
      sourcePath: staged.path,
    });

    const versionId = deterministicId(`artifact-version:${item.id}`);
    const { extraction, classification, derived, rejection } = await deriveVersionContent({
      storage,
      workspaceId: item.workspaceId,
      versionId,
      filePath: staged.path,
      filename: item.originalFilename,
      size: staged.size,
      sha256: staged.sha256,
      format: sniff.format,
      limits,
      signal,
    });
    warnings.push(...extraction.warnings);

    const identityKey = identityKeyFor(item.originalFilename);
    const textHash = extraction.plainText ? contentHash(extraction.plainText) : null;
    const autoVersion = batch.options.autoVersionByFilename !== false;

    const committed = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${item.workspaceId}:${staged.sha256}`}, 0))`,
      );
      const [locked] = await tx
        .select()
        .from(importItems)
        .where(eq(importItems.id, item.id))
        .for("update");
      if (!locked || locked.status !== "processing")
        return { skipped: locked?.status ?? "missing" } as const;
      item = locked;

      // Re-check under the lock: a concurrent item with the same bytes may have committed first.
      const usage = await findLiveUsage(tx, item.workspaceId, staged.sha256);
      if (usage) {
        await markDuplicate(tx, item, usage, { sha256: staged.sha256, detectedType });
        return {
          outcome: "duplicate_file",
          artifactId: usage.artifactId,
          versionId: usage.versionId,
        } as const;
      }

      await tx
        .insert(fileAssets)
        .values({
          workspaceId: item.workspaceId,
          storageProvider: storage.provider,
          storageKey,
          originalFilename: item.originalFilename,
          mimeType: sniff.mimeType,
          byteSize: staged.size,
          sha256: staged.sha256,
          storageStatus: "stored",
          integrityVerifiedAt: new Date(),
          createdBy: batch.createdBy,
        })
        .onConflictDoNothing({ target: [fileAssets.workspaceId, fileAssets.sha256] });
      const [asset] = await tx
        .select({ id: fileAssets.id })
        .from(fileAssets)
        .where(
          and(eq(fileAssets.workspaceId, item.workspaceId), eq(fileAssets.sha256, staged.sha256)),
        );
      if (!asset) throw new Error("file asset missing after upsert");

      const target = await resolveTarget(tx, item, identityKey, autoVersion);
      if (!target.artifactId && "ambiguous" in target && target.ambiguous) {
        warnings.push(
          "AMBIGUOUS_VERSION_MATCH: several artifacts share this filename; imported as a new artifact",
        );
      }

      let artifactId: string;
      let versionNumber: number;
      if (target.artifactId) {
        artifactId = target.artifactId;
        await tx
          .select({ id: artifacts.id })
          .from(artifacts)
          .where(eq(artifacts.id, artifactId))
          .for("update");
        const [{ max } = { max: 0 }] = await tx
          .select({ max: sql<number>`coalesce(max(${artifactVersions.versionNumber}), 0)::int` })
          .from(artifactVersions)
          .where(eq(artifactVersions.artifactId, artifactId));
        versionNumber = max + 1;
      } else {
        artifactId = deterministicId(`artifact:${item.id}`);
        versionNumber = 1;
        await tx.insert(artifacts).values({
          id: artifactId,
          workspaceId: item.workspaceId,
          projectId: batch.targetProjectId,
          title: (extraction.title ?? filenameStem(item.originalFilename)).slice(0, 500),
          summary: summarize(extraction, extraction.metadata.description),
          identityKey,
          createdBy: batch.createdBy,
        });
      }

      await tx.insert(artifactVersions).values({
        id: versionId,
        workspaceId: item.workspaceId,
        artifactId,
        versionNumber,
        primaryFileId: asset.id,
        contentKind: classification.contentKind,
        previewKind: classification.previewKind,
        previewStatus: classification.previewKind === "unsupported" ? "unavailable" : "ready",
        previewEntryPath: classification.previewEntryPath,
        processingStatus: extraction.status === "failed" ? "failed" : "ready",
        contentHash: textHash,
        sourcePlatform: extraction.metadata.sourcePlatform ?? batch.options.sourcePlatform ?? null,
        sourceModel: extraction.metadata.sourceModel ?? null,
        sourceUrl: extraction.metadata.sourceUrl ?? null,
        researchDate: extraction.metadata.researchDate ?? null,
        author: extraction.metadata.author ?? null,
        referenceSources: extraction.references,
        analysis: {
          ...classification.analysis,
          detectedFormat: sniff.format,
          sniffedMime: sniff.mimeType,
        },
        importItemId: item.id,
        createdBy: batch.createdBy,
      });
      await tx.insert(artifactFiles).values({
        artifactVersionId: versionId,
        fileAssetId: asset.id,
        role: "original",
        displayName: item.originalFilename,
      });
      if (derived.length > 0) await tx.insert(derivedAssets).values(derived);

      await saveExtraction(tx, { workspaceId: item.workspaceId, versionId, extraction });
      await tx
        .update(artifacts)
        .set({ currentVersionId: versionId })
        .where(eq(artifacts.id, artifactId));

      // FR-IMP-9: flag (never merge) other artifacts whose text is identical.
      let suspectedDuplicateOf: string | null = null;
      if (textHash) {
        const [similar] = await tx
          .select({ artifactId: artifactVersions.artifactId })
          .from(artifactVersions)
          .innerJoin(
            artifacts,
            and(eq(artifacts.id, artifactVersions.artifactId), isNull(artifacts.deletedAt)),
          )
          .where(
            and(
              eq(artifactVersions.workspaceId, item.workspaceId),
              eq(artifactVersions.contentHash, textHash),
              ne(artifactVersions.artifactId, artifactId),
            ),
          )
          .limit(1);
        if (similar) {
          suspectedDuplicateOf = similar.artifactId;
          warnings.push(
            "SUSPECTED_DUPLICATE: another artifact has identical text content; not merged",
          );
        }
      }

      await transitionItem(tx, item, rejection ? "failed" : "succeeded", {
        ...(rejection ? { errorCode: rejection.code, errorMessage: rejection.message } : {}),
        outcome: target.artifactId ? "new_version" : "new_artifact",
        matchReason: target.reason,
        fileAssetId: asset.id,
        resultArtifactId: artifactId,
        resultVersionId: versionId,
        suspectedDuplicateOf,
        sha256: staged.sha256,
        detectedType,
        warnings,
        completedAt: new Date(),
      });
      await refreshBatchStatus(tx, item.batchId);
      return {
        outcome: target.artifactId ? "new_version" : "new_artifact",
        artifactId,
        versionId,
        versionNumber,
      } as const;
    });

    await storage
      .deleteObject(item.stagingKey)
      .then(() =>
        db
          .update(importItems)
          .set({ stagingCleanedAt: new Date() })
          .where(eq(importItems.id, item.id)),
      )
      .catch((error: unknown) => {
        logger.warn({ err: error }, "staging cleanup failed; maintenance job will retry");
      });
    return { ...committed };
  } finally {
    await staged.cleanup();
  }
}

/** Marks the item failed with a user-visible reason when its job fails permanently. */
async function markItemFailed(
  db: DbExecutor,
  itemId: string,
  failure: { code: string; message: string },
) {
  await db.transaction(async (tx) => {
    const [item] = await tx
      .select()
      .from(importItems)
      .where(eq(importItems.id, itemId))
      .for("update");
    if (!item || isTerminal(item.status)) return;
    await transitionItem(tx, item, "failed", {
      errorCode: failure.code,
      errorMessage: failure.message.slice(0, 1000),
      completedAt: new Date(),
    });
    await refreshBatchStatus(tx, item.batchId);
  });
}

export function importJobDefinition(limits: ProcessLimits, timeoutMs: number): JobDefinition {
  return {
    type: IMPORT_JOB_TYPE,
    timeoutMs,
    handler: (ctx) => processImportItem(ctx, limits),
    onFailed: ({ job, db, failure }) =>
      markItemFailed(db, String(job.payload.itemId ?? ""), failure),
  };
}
