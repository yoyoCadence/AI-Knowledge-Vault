import { and, asc, count, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Database, DbExecutor } from "@/infrastructure/database/client";
import { beforeCursor, cursorTimestamp } from "@/infrastructure/database/keyset";
import {
  artifacts,
  importBatches,
  importItems,
  researchProjects,
  type ItemStatus,
} from "@/infrastructure/database/schema";
import type { SignedRequest, StorageAdapter } from "@/infrastructure/storage";
import { storageKeys } from "@/infrastructure/storage";
import type { KeysetCursor } from "@/lib/cursor";
import { AppError, notFound } from "@/lib/errors";
import { newId } from "@/lib/ids";
import { recordAudit, type RequestMeta } from "@/modules/audit";
import type { Actor } from "@/modules/auth";
import { fileExtension } from "@/modules/extraction";
import { cancelQueuedJob, enqueueJob, getJobByIdempotencyKey, retryJob } from "@/modules/jobs";
import { canTransition, TERMINAL_STATUSES } from "./state";
import {
  ALLOWED_EXTENSIONS,
  sanitizeFilename,
  type CreateBatchInput,
  type DeclareItemInput,
} from "./validation";

/**
 * Import API services (docs/IMPORT_PIPELINE.md §1, docs/API_CONTRACT.md §4).
 * All operations are workspace-scoped; items are addressed through their batch.
 */

export const IMPORT_JOB_TYPE = "import.process_item";
export const importJobKey = (itemId: string) => `${IMPORT_JOB_TYPE}:${itemId}`;

export interface ImportLimits {
  maxFileBytes: number;
  maxItemsPerBatch: number;
  uploadUrlTtlSeconds: number;
}

type ImportItemRow = typeof importItems.$inferSelect;
type ImportBatchRow = typeof importBatches.$inferSelect;

async function loadBatch(db: DbExecutor, actor: Actor, batchId: string): Promise<ImportBatchRow> {
  const [batch] = await db
    .select()
    .from(importBatches)
    .where(and(eq(importBatches.id, batchId), eq(importBatches.workspaceId, actor.workspaceId)));
  if (!batch) throw notFound("Import batch");
  return batch;
}

async function loadItem(
  db: DbExecutor,
  actor: Actor,
  batchId: string,
  itemId: string,
  lock = false,
) {
  const query = db
    .select()
    .from(importItems)
    .where(
      and(
        eq(importItems.id, itemId),
        eq(importItems.batchId, batchId),
        eq(importItems.workspaceId, actor.workspaceId),
      ),
    );
  const [item] = lock ? await query.for("update") : await query;
  if (!item) throw notFound("Import item");
  return item;
}

export async function createBatch(
  db: Database,
  actor: Actor,
  input: CreateBatchInput,
): Promise<ImportBatchRow> {
  if (input.projectId) {
    const [project] = await db
      .select({ id: researchProjects.id })
      .from(researchProjects)
      .where(
        and(
          eq(researchProjects.id, input.projectId),
          eq(researchProjects.workspaceId, actor.workspaceId),
          isNull(researchProjects.deletedAt),
        ),
      );
    if (!project) throw notFound("Research project");
  }
  const [batch] = await db
    .insert(importBatches)
    .values({
      workspaceId: actor.workspaceId,
      createdBy: actor.userId,
      targetProjectId: input.projectId ?? null,
      options: {
        autoVersionByFilename: input.options?.autoVersionByFilename ?? true,
        ...(input.options?.sourcePlatform ? { sourcePlatform: input.options.sourcePlatform } : {}),
      },
    })
    .returning();
  return batch!;
}

async function signUpload(
  storage: StorageAdapter,
  item: ImportItemRow,
  limits: ImportLimits,
): Promise<SignedRequest> {
  return storage.createSignedUploadUrl(item.stagingKey, {
    contentLength: item.declaredSize,
    expiresInSeconds: limits.uploadUrlTtlSeconds,
  });
}

/**
 * Declares one file of a batch and returns a time-limited direct-upload URL. Idempotent on
 * `clientKey`: a client retrying the same declaration gets the same item and a fresh URL.
 */
export async function declareItem(
  db: Database,
  storage: StorageAdapter,
  actor: Actor,
  batchId: string,
  input: DeclareItemInput,
  limits: ImportLimits,
): Promise<{ item: ImportItemRow; upload: SignedRequest | null; created: boolean }> {
  const batch = await loadBatch(db, actor, batchId);
  if (batch.status === "cancelled")
    throw new AppError("CONFLICT", "This import batch was cancelled");

  const filename = sanitizeFilename(input.filename);
  const extension = fileExtension(filename);
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new AppError(
      "UNSUPPORTED_FILE_TYPE",
      `Unsupported file type: .${extension || "(none)"}`,
      {
        details: { allowed: [...ALLOWED_EXTENSIONS] },
      },
    );
  }
  if (input.size > limits.maxFileBytes) {
    throw new AppError(
      "PAYLOAD_TOO_LARGE",
      `File exceeds the limit of ${limits.maxFileBytes} bytes`,
    );
  }
  if (input.size === 0) throw new AppError("VALIDATION_FAILED", "Empty files cannot be imported");

  if (input.clientKey) {
    const [existing] = await db
      .select()
      .from(importItems)
      .where(and(eq(importItems.batchId, batch.id), eq(importItems.clientKey, input.clientKey)));
    if (existing) {
      const upload =
        existing.status === "awaiting_upload" ? await signUpload(storage, existing, limits) : null;
      return { item: existing, upload, created: false };
    }
  }

  if (input.targetArtifactId) {
    const [target] = await db
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.id, input.targetArtifactId),
          eq(artifacts.workspaceId, actor.workspaceId),
          isNull(artifacts.deletedAt),
        ),
      );
    if (!target) throw notFound("Artifact");
  }

  const [{ value: itemCount } = { value: 0 }] = await db
    .select({ value: count() })
    .from(importItems)
    .where(eq(importItems.batchId, batch.id));
  if (itemCount >= limits.maxItemsPerBatch) {
    throw new AppError("CONFLICT", `A batch can hold at most ${limits.maxItemsPerBatch} files`);
  }

  const itemId = newId();
  const [item] = await db
    .insert(importItems)
    .values({
      id: itemId,
      workspaceId: actor.workspaceId,
      batchId: batch.id,
      clientKey: input.clientKey ?? null,
      originalFilename: filename,
      declaredSize: input.size,
      declaredMime: input.mimeType ?? null,
      stagingKey: storageKeys.staging(actor.workspaceId, itemId),
      targetArtifactId: input.targetArtifactId ?? null,
      uploadExpiresAt: new Date(Date.now() + limits.uploadUrlTtlSeconds * 1000),
    })
    .onConflictDoNothing({ target: [importItems.batchId, importItems.clientKey] })
    .returning();
  if (!item) {
    // Lost a race with a concurrent declaration of the same clientKey.
    return declareItem(db, storage, actor, batchId, input, limits);
  }
  return { item, upload: await signUpload(storage, item, limits), created: true };
}

/**
 * Confirms an upload: verifies the staged object exists with the declared size, then queues the
 * processing job in the same transaction as the status change. Idempotent.
 */
export async function completeItem(
  db: Database,
  storage: StorageAdapter,
  actor: Actor,
  batchId: string,
  itemId: string,
): Promise<ImportItemRow> {
  const current = await loadItem(db, actor, batchId, itemId);
  if (!["awaiting_upload", "uploaded"].includes(current.status)) return current;

  const head = await storage.headObject(current.stagingKey);
  if (!head) throw new AppError("UPLOAD_INCOMPLETE", "The file has not been uploaded yet");
  if (head.size !== current.declaredSize) {
    await db.transaction(async (tx) => {
      const item = await loadItem(tx, actor, batchId, itemId, true);
      if (!["awaiting_upload", "uploaded"].includes(item.status)) return;
      await transitionItem(tx, item, "failed", {
        errorCode: "SIZE_MISMATCH",
        errorMessage: `uploaded ${head.size} bytes, declared ${current.declaredSize}`,
        completedAt: new Date(),
      });
      await refreshBatchStatus(tx, item.batchId);
    });
    // The bytes are wrong, so the item cannot be retried; it must be uploaded again.
    await storage.deleteObject(current.stagingKey);
    await db
      .update(importItems)
      .set({ stagingCleanedAt: new Date() })
      .where(eq(importItems.id, current.id));
    throw new AppError("SIZE_MISMATCH", "Uploaded size does not match the declared size");
  }

  return db.transaction(async (tx) => {
    const item = await loadItem(tx, actor, batchId, itemId, true);
    if (!["awaiting_upload", "uploaded"].includes(item.status)) return item;
    await enqueueJob(tx, {
      type: IMPORT_JOB_TYPE,
      idempotencyKey: importJobKey(item.id),
      workspaceId: item.workspaceId,
      payload: { itemId: item.id },
    });
    const updated = await transitionItem(tx, item, "queued", {
      errorCode: null,
      errorMessage: null,
    });
    // Also reopens a finished batch that receives a new file, so its status and
    // completedAt are recomputed when the new item finishes.
    await tx
      .update(importBatches)
      .set({ status: "processing", completedAt: null })
      .where(and(eq(importBatches.id, item.batchId), ne(importBatches.status, "cancelled")));
    return updated;
  });
}

/**
 * Whether a failed item can be re-queued. Processing always starts from the staged upload, so
 * the staged bytes must still exist; and an item that already committed an artifact version
 * (an archive rejected after its original was preserved) is final: re-running it would only
 * find its own original again. Re-processing existing versions is a separate, future feature.
 */
export function isRetryable(
  item: Pick<ImportItemRow, "status" | "resultVersionId" | "stagingCleanedAt">,
): boolean {
  return item.status === "failed" && item.resultVersionId === null && !item.stagingCleanedAt;
}

/** Re-queues a failed item whose staged upload still exists. */
export async function retryItem(
  db: Database,
  storage: StorageAdapter,
  actor: Actor,
  batchId: string,
  itemId: string,
): Promise<ImportItemRow> {
  return db.transaction(async (tx) => {
    const item = await loadItem(tx, actor, batchId, itemId, true);
    if (item.status !== "failed")
      throw new AppError("NOT_RETRYABLE", "Only failed items can be retried");
    if (item.resultVersionId !== null) {
      throw new AppError(
        "NOT_RETRYABLE",
        "This file was already preserved as an artifact; open it to inspect the original",
      );
    }
    if (!isRetryable(item) || (await storage.headObject(item.stagingKey)) === null) {
      throw new AppError(
        "NOT_RETRYABLE",
        "The uploaded file is no longer available; upload it again",
      );
    }
    const job = await getJobByIdempotencyKey(tx, importJobKey(item.id));
    if (job) {
      if (job.status === "failed" || job.status === "cancelled") await retryJob(tx, job.id);
    } else {
      await enqueueJob(tx, {
        type: IMPORT_JOB_TYPE,
        idempotencyKey: importJobKey(item.id),
        workspaceId: item.workspaceId,
        payload: { itemId: item.id },
      });
    }
    await tx
      .update(importBatches)
      .set({ status: "processing", completedAt: null })
      .where(eq(importBatches.id, item.batchId));
    return transitionItem(tx, item, "queued", {
      errorCode: null,
      errorMessage: null,
      completedAt: null,
    });
  });
}

/** Cancels an item that has not started processing; removes its staged bytes. */
export async function cancelItem(
  db: Database,
  storage: StorageAdapter,
  actor: Actor,
  batchId: string,
  itemId: string,
): Promise<ImportItemRow> {
  const updated = await db.transaction(async (tx) => {
    const item = await loadItem(tx, actor, batchId, itemId, true);
    if (!canTransition(item.status, "cancelled")) {
      throw new AppError("CONFLICT", `Item cannot be cancelled while ${item.status}`);
    }
    const job = await getJobByIdempotencyKey(tx, importJobKey(item.id));
    if (job && !(await cancelQueuedJob(tx, job.id)) && job.status === "running") {
      throw new AppError("CONFLICT", "Item is already being processed");
    }
    const result = await transitionItem(tx, item, "cancelled", { completedAt: new Date() });
    await refreshBatchStatus(tx, item.batchId);
    return result;
  });
  await storage.deleteObject(updated.stagingKey);
  await db
    .update(importItems)
    .set({ stagingCleanedAt: new Date() })
    .where(eq(importItems.id, updated.id));
  return updated;
}

/** Applies a validated status transition; throws on illegal transitions. */
export async function transitionItem(
  db: DbExecutor,
  item: Pick<ImportItemRow, "id" | "status">,
  to: ItemStatus,
  patch: Partial<typeof importItems.$inferInsert> = {},
): Promise<ImportItemRow> {
  if (!canTransition(item.status, to)) {
    throw new Error(`illegal import item transition ${item.status} → ${to}`);
  }
  const [updated] = await db
    .update(importItems)
    .set({ ...patch, status: to })
    .where(and(eq(importItems.id, item.id), eq(importItems.status, item.status)))
    .returning();
  if (!updated)
    throw new AppError("CONFLICT", "Import item changed concurrently; retry", { retryable: true });
  return updated;
}

/**
 * Completes the batch once every item is terminal. Must run inside the transaction that made
 * an item terminal: the batch row lock serializes concurrent finishers, so the last one to
 * commit always counts the others' committed states (READ COMMITTED takes a fresh snapshot
 * per statement) and no batch is left "processing" with only terminal items.
 */
export async function refreshBatchStatus(db: DbExecutor, batchId: string): Promise<void> {
  await db
    .select({ id: importBatches.id })
    .from(importBatches)
    .where(eq(importBatches.id, batchId))
    .for("update");
  const rows = await db
    .select({ status: importItems.status, n: count() })
    .from(importItems)
    .where(eq(importItems.batchId, batchId))
    .groupBy(importItems.status);
  const total = rows.reduce((sum, row) => sum + row.n, 0);
  if (total === 0) return;
  const unfinished = rows
    .filter((row) => !TERMINAL_STATUSES.includes(row.status))
    .reduce((sum, row) => sum + row.n, 0);
  const failed = rows.filter((row) => row.status === "failed").reduce((sum, row) => sum + row.n, 0);
  if (unfinished > 0) return;
  await db
    .update(importBatches)
    .set({ status: failed > 0 ? "completed_with_errors" : "completed", completedAt: sql`now()` })
    .where(
      and(eq(importBatches.id, batchId), inArray(importBatches.status, ["open", "processing"])),
    );
}

export interface BatchReport {
  batch: ImportBatchRow;
  counts: Record<ItemStatus | "total", number>;
  items: (ImportItemRow & { resultArtifactTitle: string | null })[];
}

export async function getBatchReport(
  db: DbExecutor,
  actor: Actor,
  batchId: string,
): Promise<BatchReport> {
  const batch = await loadBatch(db, actor, batchId);
  const rows = await db
    .select({ item: importItems, resultArtifactTitle: artifacts.title })
    .from(importItems)
    .leftJoin(artifacts, eq(artifacts.id, importItems.resultArtifactId))
    .where(eq(importItems.batchId, batch.id))
    .orderBy(asc(importItems.createdAt));
  const counts = { total: rows.length } as Record<ItemStatus | "total", number>;
  for (const status of [
    "awaiting_upload",
    "uploaded",
    "queued",
    "processing",
    "succeeded",
    "duplicate",
    "failed",
    "cancelled",
    "expired",
  ] as const) {
    counts[status] = rows.filter((row) => row.item.status === status).length;
  }
  return {
    batch,
    counts,
    items: rows.map((row) => ({ ...row.item, resultArtifactTitle: row.resultArtifactTitle })),
  };
}

export async function listBatches(
  db: DbExecutor,
  actor: Actor,
  options: { limit: number; cursor?: KeysetCursor },
) {
  const rows = await db
    .select({
      id: importBatches.id,
      status: importBatches.status,
      createdAt: importBatches.createdAt,
      cursorCreatedAt: cursorTimestamp(importBatches.createdAt),
      completedAt: importBatches.completedAt,
      total: sql<number>`count(${importItems.id})::int`,
      failed: sql<number>`(count(${importItems.id}) filter (where ${importItems.status} = 'failed'))::int`,
    })
    .from(importBatches)
    .leftJoin(importItems, eq(importItems.batchId, importBatches.id))
    .where(
      and(
        eq(importBatches.workspaceId, actor.workspaceId),
        beforeCursor(importBatches.createdAt, importBatches.id, options.cursor),
      ),
    )
    .groupBy(importBatches.id)
    .orderBy(desc(importBatches.createdAt), desc(importBatches.id))
    .limit(options.limit + 1);
  const items = rows.slice(0, options.limit).map(({ cursorCreatedAt: _, ...row }) => row);
  const last = rows[options.limit - 1];
  return {
    items,
    nextCursor:
      rows.length > options.limit && last ? { createdAt: last.cursorCreatedAt, id: last.id } : null,
  };
}

export async function auditBatchCreated(
  db: DbExecutor,
  actor: Actor,
  batchId: string,
  meta: RequestMeta,
) {
  await recordAudit(db, {
    action: "import.batch.created",
    workspaceId: actor.workspaceId,
    actorUserId: actor.userId,
    targetType: "import_batch",
    targetId: batchId,
    ...meta,
  });
}
