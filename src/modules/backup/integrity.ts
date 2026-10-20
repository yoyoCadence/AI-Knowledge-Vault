import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import type { Database, DbExecutor } from "@/infrastructure/database/client";
import {
  fileAssets,
  integrityChecks,
  workspaces,
  type FileStorageStatus,
} from "@/infrastructure/database/schema";
import { StorageObjectNotFoundError } from "@/infrastructure/storage";
import { newId } from "@/lib/ids";
import { recordAudit, type RequestMeta } from "@/modules/audit";
import type { Actor } from "@/modules/auth";
import { enqueueJob, type JobContext, type JobDefinition } from "@/modules/jobs";

/**
 * Integrity checks (BACKUP_RECOVERY §7): re-hash every stored original of a workspace and record
 * what is `stored` (verified), `missing` or `corrupt`. Only `storage_status` and
 * `integrity_verified_at` change on file_assets, which the immutability trigger allows.
 *
 * Idempotency: a run recomputes every count from scratch, so a retried job overwrites the
 * same `integrity_checks` row with the same result; a completed run is skipped.
 */

export const INTEGRITY_JOB_TYPE = "integrity.check";
export const INTEGRITY_SCHEDULE_JOB_TYPE = "maintenance.schedule_integrity_checks";
const PAGE_SIZE = 200;
const MAX_LISTED_FAILURES = 1_000;

export type IntegrityCheck = typeof integrityChecks.$inferSelect;

export interface IntegrityFailure {
  fileAssetId: string;
  sha256: string;
  originalFilename: string;
  status: Exclude<FileStorageStatus, "stored">;
}

export function toIntegrityDto(check: IntegrityCheck) {
  return {
    id: check.id,
    status: check.status,
    checkedCount: check.checkedCount,
    okCount: check.okCount,
    missingCount: check.missingCount,
    corruptCount: check.corruptCount,
    failures: ((check.report.failures as IntegrityFailure[] | undefined) ?? []).slice(0, 50),
    startedAt: check.startedAt,
    completedAt: check.completedAt,
  };
}

/** Queues a check unless one is already queued or running for the workspace. */
export async function requestIntegrityCheck(
  db: Database,
  workspaceId: string,
  options: { actorUserId?: string | null; meta?: RequestMeta } = {},
): Promise<IntegrityCheck> {
  return db.transaction(async (tx) => {
    await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .for("update");
    const [pending] = await tx
      .select()
      .from(integrityChecks)
      .where(
        and(
          eq(integrityChecks.workspaceId, workspaceId),
          inArray(integrityChecks.status, ["queued", "running"]),
        ),
      )
      .limit(1);
    if (pending) return pending;
    const id = newId();
    await enqueueJob(tx, {
      type: INTEGRITY_JOB_TYPE,
      idempotencyKey: `${INTEGRITY_JOB_TYPE}:${id}`,
      workspaceId,
      payload: { checkId: id },
      maxAttempts: 3,
    });
    const [check] = await tx
      .insert(integrityChecks)
      .values({ id, workspaceId, status: "queued" })
      .returning();
    if (options.actorUserId) {
      await recordAudit(tx, {
        action: "backup.integrity.requested",
        workspaceId,
        actorUserId: options.actorUserId,
        targetType: "integrity_check",
        targetId: id,
        ...options.meta,
      });
    }
    return check!;
  });
}

export async function latestIntegrityCheck(
  db: DbExecutor,
  actor: Actor,
): Promise<IntegrityCheck | null> {
  const [check] = await db
    .select()
    .from(integrityChecks)
    .where(eq(integrityChecks.workspaceId, actor.workspaceId))
    .orderBy(desc(integrityChecks.startedAt))
    .limit(1);
  return check ?? null;
}

async function hashObject(
  ctx: JobContext,
  storageKey: string,
): Promise<{ sha256: string; size: number } | null> {
  let body;
  try {
    ({ body } = await ctx.storage.getObject(storageKey));
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) return null;
    throw error;
  }
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of body) {
    ctx.signal.throwIfAborted();
    size += (chunk as Buffer).length;
    hash.update(chunk as Buffer);
  }
  return { sha256: hash.digest("hex"), size };
}

export async function runIntegrityCheck(ctx: JobContext): Promise<Record<string, unknown>> {
  const { db } = ctx;
  const checkId = String(ctx.job.payload.checkId ?? "");
  const [check] = await db.select().from(integrityChecks).where(eq(integrityChecks.id, checkId));
  if (!check) return { skipped: "missing_check" };
  if (check.status === "completed") return { skipped: "completed" };
  await db
    .update(integrityChecks)
    .set({ status: "running", startedAt: new Date() })
    .where(eq(integrityChecks.id, check.id));

  const total = (
    await db
      .select({ id: fileAssets.id })
      .from(fileAssets)
      .where(eq(fileAssets.workspaceId, check.workspaceId))
  ).length;
  const counts = { checked: 0, ok: 0, missing: 0, corrupt: 0 };
  const failures: IntegrityFailure[] = [];
  let after: string | null = null;
  for (;;) {
    const page: (typeof fileAssets.$inferSelect)[] = await db
      .select()
      .from(fileAssets)
      .where(
        and(
          eq(fileAssets.workspaceId, check.workspaceId),
          after ? gt(fileAssets.id, after) : undefined,
        ),
      )
      .orderBy(asc(fileAssets.id))
      .limit(PAGE_SIZE);
    if (page.length === 0) break;
    for (const asset of page) {
      ctx.signal.throwIfAborted();
      const actual = await hashObject(ctx, asset.storageKey);
      const status: FileStorageStatus =
        actual === null
          ? "missing"
          : actual.sha256 === asset.sha256 && actual.size === asset.byteSize
            ? "stored"
            : "corrupt";
      counts.checked += 1;
      if (status === "stored") counts.ok += 1;
      else {
        counts[status] += 1;
        if (failures.length < MAX_LISTED_FAILURES) {
          failures.push({
            fileAssetId: asset.id,
            sha256: asset.sha256,
            originalFilename: asset.originalFilename,
            status,
          });
        }
      }
      await db
        .update(fileAssets)
        .set({
          storageStatus: status,
          ...(status === "stored" ? { integrityVerifiedAt: new Date() } : {}),
          updatedAt: new Date(),
        })
        .where(eq(fileAssets.id, asset.id));
    }
    after = page.at(-1)!.id;
    await ctx.reportProgress({ current: counts.checked, total });
  }

  await db
    .update(integrityChecks)
    .set({
      status: "completed",
      checkedCount: counts.checked,
      okCount: counts.ok,
      missingCount: counts.missing,
      corruptCount: counts.corrupt,
      report: { failures },
      completedAt: new Date(),
    })
    .where(eq(integrityChecks.id, check.id));
  if (counts.missing + counts.corrupt > 0) {
    ctx.logger.error(
      { checkId: check.id, missing: counts.missing, corrupt: counts.corrupt },
      "integrity check found damaged originals",
    );
  }
  return { checkId: check.id, ...counts };
}

export function integrityJobDefinition(timeoutMs: number): JobDefinition {
  return {
    type: INTEGRITY_JOB_TYPE,
    timeoutMs,
    handler: runIntegrityCheck,
    onFailed: async ({ job, db, failure }) => {
      await db
        .update(integrityChecks)
        .set({
          status: "failed",
          report: { error: `${failure.code}: ${failure.message}`.slice(0, 1000) },
          completedAt: new Date(),
        })
        .where(
          and(
            eq(integrityChecks.id, String(job.payload.checkId ?? "")),
            inArray(integrityChecks.status, ["queued", "running"]),
          ),
        );
    },
  };
}

/** Weekly maintenance: queue one check per workspace (skipped where one is already pending). */
export function integrityScheduleJobDefinition(): JobDefinition {
  return {
    type: INTEGRITY_SCHEDULE_JOB_TYPE,
    timeoutMs: 5 * 60 * 1000,
    handler: async ({ db }) => {
      const rows = await db.select({ id: workspaces.id }).from(workspaces);
      for (const row of rows) await requestIntegrityCheck(db, row.id);
      return { workspaces: rows.length };
    },
  };
}
