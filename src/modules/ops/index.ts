import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { DbExecutor } from "@/infrastructure/database/client";
import {
  artifacts,
  artifactVersions,
  derivedAssets,
  exportRuns,
  fileAssets,
  importItems,
  integrityChecks,
  JOB_STATUSES,
  processingJobs,
  type JobStatus,
} from "@/infrastructure/database/schema";
import type { Actor } from "@/modules/auth";

/**
 * Usage and health of a workspace (FR-OPS-2, FR-OPS-3), for its owner. Every number is read from
 * the database as it is: sizes are what the vault recorded when it stored each object (the
 * storage provider is not asked), and nothing is estimated. The database size is the whole
 * database's, shared by every workspace in it.
 */

const RECENT_FAILURES = 10;
/** Error texts are shown, not stored again: long ones are cut. */
const ERROR_TEXT_MAX = 300;

export interface Tally {
  count: number;
  bytes: number;
}

export interface UsageReport {
  generatedAt: Date;
  storage: {
    originals: Tally & { missing: number; corrupt: number };
    previewFiles: Tally;
    thumbnails: Tally;
    /** Export archives not yet deleted by retention. */
    exports: Tally;
    totalBytes: number;
  };
  library: { artifacts: number; versions: number };
  database: { bytes: number };
  jobs: {
    byStatus: Record<JobStatus, number>;
    recentFailures: {
      id: string;
      type: string;
      errorCode: string | null;
      error: string | null;
      failedAt: Date;
    }[];
  };
  imports: {
    failed: number;
    recentFailures: {
      id: string;
      filename: string;
      errorCode: string | null;
      error: string | null;
      failedAt: Date;
    }[];
  };
  backup: {
    lastExport: { id: string; completedAt: Date; bytes: number | null } | null;
    latestExport: { id: string; status: string; createdAt: Date } | null;
    lastIntegrityCheck: {
      id: string;
      completedAt: Date;
      checked: number;
      ok: number;
      missing: number;
      corrupt: number;
    } | null;
    latestIntegrityCheck: { id: string; status: string; startedAt: Date } | null;
  };
}

const tally = (row: { count: number; bytes: string | number | null } | undefined): Tally => ({
  count: row?.count ?? 0,
  bytes: Number(row?.bytes ?? 0),
});

const cut = (text: string | null) =>
  text && text.length > ERROR_TEXT_MAX ? `${text.slice(0, ERROR_TEXT_MAX)}…` : text;

export async function getUsageReport(
  db: DbExecutor,
  actor: Actor,
  now = new Date(),
): Promise<UsageReport> {
  const ws = actor.workspaceId;
  const byteSum = (column: AnyPgColumn) => sql<string>`coalesce(sum(${column}), 0)::bigint`;

  const [originals] = await db
    .select({
      count: sql<number>`count(*)::int`,
      bytes: byteSum(fileAssets.byteSize),
      missing: sql<number>`count(*) filter (where ${fileAssets.storageStatus} = 'missing')::int`,
      corrupt: sql<number>`count(*) filter (where ${fileAssets.storageStatus} = 'corrupt')::int`,
    })
    .from(fileAssets)
    .where(eq(fileAssets.workspaceId, ws));

  const derived = await db
    .select({
      kind: derivedAssets.kind,
      count: sql<number>`count(*)::int`,
      bytes: byteSum(derivedAssets.byteSize),
    })
    .from(derivedAssets)
    .where(eq(derivedAssets.workspaceId, ws))
    .groupBy(derivedAssets.kind);

  const [archives] = await db
    .select({ count: sql<number>`count(*)::int`, bytes: byteSum(exportRuns.byteSize) })
    .from(exportRuns)
    .where(
      and(
        eq(exportRuns.workspaceId, ws),
        eq(exportRuns.status, "completed"),
        isNotNull(exportRuns.storageKey),
      ),
    );

  const [library] = await db
    .select({
      artifacts: sql<number>`count(distinct ${artifacts.id})::int`,
      versions: sql<number>`count(${artifactVersions.id})::int`,
    })
    .from(artifacts)
    .leftJoin(artifactVersions, eq(artifactVersions.artifactId, artifacts.id))
    .where(and(eq(artifacts.workspaceId, ws), isNull(artifacts.deletedAt)));

  const [database] = await db
    .execute<{ bytes: string }>(sql`select pg_database_size(current_database())::bigint as bytes`)
    .then((result) => result.rows);

  const jobCounts = await db
    .select({ status: processingJobs.status, count: sql<number>`count(*)::int` })
    .from(processingJobs)
    .where(eq(processingJobs.workspaceId, ws))
    .groupBy(processingJobs.status);
  const byStatus = Object.fromEntries(JOB_STATUSES.map((status) => [status, 0])) as Record<
    JobStatus,
    number
  >;
  for (const row of jobCounts) byStatus[row.status] = row.count;

  // When it failed: later bookkeeping (staging cleanup, …) touches updatedAt, never this.
  const jobFailedAt = sql<Date>`coalesce(${processingJobs.completedAt}, ${processingJobs.updatedAt})`;
  const itemFailedAt = sql<Date>`coalesce(${importItems.completedAt}, ${importItems.updatedAt})`;
  const failedJobs = await db
    .select({
      id: processingJobs.id,
      type: processingJobs.type,
      errorCode: processingJobs.errorCode,
      error: processingJobs.lastError,
      failedAt: jobFailedAt.mapWith(processingJobs.completedAt),
    })
    .from(processingJobs)
    .where(and(eq(processingJobs.workspaceId, ws), eq(processingJobs.status, "failed")))
    .orderBy(desc(jobFailedAt), desc(processingJobs.id))
    .limit(RECENT_FAILURES);

  const [failedImportCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(importItems)
    .where(and(eq(importItems.workspaceId, ws), eq(importItems.status, "failed")));
  const failedImports = await db
    .select({
      id: importItems.id,
      filename: importItems.originalFilename,
      errorCode: importItems.errorCode,
      error: importItems.errorMessage,
      failedAt: itemFailedAt.mapWith(importItems.completedAt),
    })
    .from(importItems)
    .where(and(eq(importItems.workspaceId, ws), eq(importItems.status, "failed")))
    .orderBy(desc(itemFailedAt), desc(importItems.id))
    .limit(RECENT_FAILURES);

  const [lastExport] = await db
    .select({ id: exportRuns.id, completedAt: exportRuns.completedAt, bytes: exportRuns.byteSize })
    .from(exportRuns)
    .where(and(eq(exportRuns.workspaceId, ws), eq(exportRuns.status, "completed")))
    .orderBy(desc(exportRuns.completedAt))
    .limit(1);
  const [latestExport] = await db
    .select({ id: exportRuns.id, status: exportRuns.status, createdAt: exportRuns.createdAt })
    .from(exportRuns)
    .where(eq(exportRuns.workspaceId, ws))
    .orderBy(desc(exportRuns.createdAt))
    .limit(1);
  const [lastCheck] = await db
    .select({
      id: integrityChecks.id,
      completedAt: integrityChecks.completedAt,
      checked: integrityChecks.checkedCount,
      ok: integrityChecks.okCount,
      missing: integrityChecks.missingCount,
      corrupt: integrityChecks.corruptCount,
    })
    .from(integrityChecks)
    .where(and(eq(integrityChecks.workspaceId, ws), eq(integrityChecks.status, "completed")))
    .orderBy(desc(integrityChecks.completedAt))
    .limit(1);
  const [latestCheck] = await db
    .select({
      id: integrityChecks.id,
      status: integrityChecks.status,
      startedAt: integrityChecks.startedAt,
    })
    .from(integrityChecks)
    .where(eq(integrityChecks.workspaceId, ws))
    .orderBy(desc(integrityChecks.startedAt))
    .limit(1);

  const kind = (name: string) => tally(derived.find((row) => row.kind === name));
  const storage = {
    originals: {
      ...tally(originals),
      missing: originals?.missing ?? 0,
      corrupt: originals?.corrupt ?? 0,
    },
    previewFiles: kind("preview_file"),
    thumbnails: kind("thumbnail"),
    exports: tally(archives),
  };
  return {
    generatedAt: now,
    storage: {
      ...storage,
      totalBytes:
        storage.originals.bytes +
        storage.previewFiles.bytes +
        storage.thumbnails.bytes +
        storage.exports.bytes,
    },
    library: { artifacts: library?.artifacts ?? 0, versions: library?.versions ?? 0 },
    database: { bytes: Number(database?.bytes ?? 0) },
    jobs: {
      byStatus,
      recentFailures: failedJobs.map((job) => ({ ...job, error: cut(job.error) })),
    },
    imports: {
      failed: failedImportCount?.count ?? 0,
      recentFailures: failedImports.map((item) => ({ ...item, error: cut(item.error) })),
    },
    backup: {
      lastExport:
        lastExport?.completedAt != null
          ? { id: lastExport.id, completedAt: lastExport.completedAt, bytes: lastExport.bytes }
          : null,
      latestExport: latestExport ?? null,
      lastIntegrityCheck:
        lastCheck?.completedAt != null
          ? { ...lastCheck, completedAt: lastCheck.completedAt }
          : null,
      latestIntegrityCheck: latestCheck ?? null,
    },
  };
}
