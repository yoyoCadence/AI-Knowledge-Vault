import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Database, DbExecutor } from "@/infrastructure/database/client";
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
  type ContentKind,
  type JobStatus,
} from "@/infrastructure/database/schema";
import type { Actor } from "@/modules/auth";
import { JOB_RETENTION_DAYS } from "@/modules/imports";

/**
 * Usage and health of a workspace (FR-OPS-2, FR-OPS-3), for its owner. Every number is read from
 * the database as it is: sizes are what the vault recorded when it stored each object (the
 * storage provider is not asked), and nothing is estimated. The database size is the whole
 * database's, shared by every workspace in it.
 */

const RECENT_FAILURES = 10;
/** Error texts are shown, not stored again: long ones are cut. */
const ERROR_TEXT_MAX = 300;
/** The job counts cover only the history imports maintenance keeps (see JOB_RETENTION_DAYS). */
export const JOB_HISTORY_DAYS = JOB_RETENTION_DAYS;
/**
 * Unexpected errors (no AppError) carry raw driver or filesystem messages, paths included. Like
 * the HTTP layer, the report shows only their code; the details are in the worker's log.
 */
const INTERNAL_ERROR = "INTERNAL_ERROR";

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

const shownError = (row: { errorCode: string | null; error: string | null }) =>
  row.errorCode === INTERNAL_ERROR ? null : cut(row.error);

const byteSum = (column: AnyPgColumn) => sql<string>`coalesce(sum(${column}), 0)::bigint`;

/** Stored originals: how many, their bytes, and how many were found missing or corrupt. */
async function originalsOf(db: DbExecutor, ws: string) {
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      bytes: byteSum(fileAssets.byteSize),
      missing: sql<number>`count(*) filter (where ${fileAssets.storageStatus} = 'missing')::int`,
      corrupt: sql<number>`count(*) filter (where ${fileAssets.storageStatus} = 'corrupt')::int`,
    })
    .from(fileAssets)
    .where(eq(fileAssets.workspaceId, ws));
  return { ...tally(row), missing: row?.missing ?? 0, corrupt: row?.corrupt ?? 0 };
}

const liveArtifacts = (ws: string) =>
  and(eq(artifacts.workspaceId, ws), isNull(artifacts.deletedAt));

/** Artifacts not deleted, and their versions. */
async function libraryOf(db: DbExecutor, ws: string) {
  // Two counts: one count(distinct) over the join sorts every version (slow past ~100k).
  const [artifactCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(artifacts)
    .where(liveArtifacts(ws));
  const [versionCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(artifactVersions)
    .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
    .where(liveArtifacts(ws));
  return { artifacts: artifactCount?.count ?? 0, versions: versionCount?.count ?? 0 };
}

/** The newest completed export, if any. */
async function lastExportOf(db: DbExecutor, ws: string) {
  const [row] = await db
    .select({ id: exportRuns.id, completedAt: exportRuns.completedAt, bytes: exportRuns.byteSize })
    .from(exportRuns)
    .where(
      and(
        eq(exportRuns.workspaceId, ws),
        eq(exportRuns.status, "completed"),
        isNotNull(exportRuns.completedAt),
      ),
    )
    .orderBy(desc(exportRuns.completedAt))
    .limit(1);
  return row?.completedAt != null
    ? { id: row.id, completedAt: row.completedAt, bytes: row.bytes }
    : null;
}

/** The newest completed integrity check, if any. */
async function lastIntegrityCheckOf(db: DbExecutor, ws: string) {
  const [row] = await db
    .select({
      id: integrityChecks.id,
      completedAt: integrityChecks.completedAt,
      checked: integrityChecks.checkedCount,
      ok: integrityChecks.okCount,
      missing: integrityChecks.missingCount,
      corrupt: integrityChecks.corruptCount,
    })
    .from(integrityChecks)
    .where(
      and(
        eq(integrityChecks.workspaceId, ws),
        eq(integrityChecks.status, "completed"),
        isNotNull(integrityChecks.completedAt),
      ),
    )
    .orderBy(desc(integrityChecks.completedAt))
    .limit(1);
  return row?.completedAt != null ? { ...row, completedAt: row.completedAt } : null;
}

/** What the library page shows of its workspace (FR-LIB-1: how many works, how they are kept). */
export interface LibrarySummary {
  library: { artifacts: number; versions: number };
  /** Artifacts by their current version's kind, most first. */
  kinds: { kind: ContentKind; count: number }[];
  originals: Tally & { missing: number; corrupt: number };
  lastExportAt: Date | null;
  lastIntegrityCheckAt: Date | null;
}

/**
 * The library page's summary, for any member: the same numbers as the usage report (its
 * queries are shared), without anything only owners see (jobs, errors, database size). One
 * read-only REPEATABLE READ snapshot, like the report.
 */
export function getLibrarySummary(database: Database, actor: Actor): Promise<LibrarySummary> {
  return database.transaction(
    async (db) => {
      const ws = actor.workspaceId;
      const kinds = await db
        .select({ kind: artifactVersions.contentKind, count: sql<number>`count(*)::int` })
        .from(artifacts)
        .innerJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
        .where(liveArtifacts(ws))
        .groupBy(artifactVersions.contentKind)
        .orderBy(desc(sql`count(*)`), asc(artifactVersions.contentKind));
      const lastExport = await lastExportOf(db, ws);
      const lastCheck = await lastIntegrityCheckOf(db, ws);
      return {
        library: await libraryOf(db, ws),
        kinds,
        originals: await originalsOf(db, ws),
        lastExportAt: lastExport?.completedAt ?? null,
        lastIntegrityCheckAt: lastCheck?.completedAt ?? null,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/**
 * The report, read in one read-only REPEATABLE READ transaction, so its numbers come from one
 * snapshot (a failed-job count and its list cannot disagree).
 */
export function getUsageReport(
  database: Database,
  actor: Actor,
  now = new Date(),
): Promise<UsageReport> {
  return database.transaction((tx) => readReport(tx, actor, now), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}

async function readReport(db: DbExecutor, actor: Actor, now: Date): Promise<UsageReport> {
  const ws = actor.workspaceId;
  const originals = await originalsOf(db, ws);

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

  const library = await libraryOf(db, ws);

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

  const lastExport = await lastExportOf(db, ws);
  const [latestExport] = await db
    .select({ id: exportRuns.id, status: exportRuns.status, createdAt: exportRuns.createdAt })
    .from(exportRuns)
    .where(eq(exportRuns.workspaceId, ws))
    .orderBy(desc(exportRuns.createdAt))
    .limit(1);
  const lastCheck = await lastIntegrityCheckOf(db, ws);
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
    originals,
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
    library,
    database: { bytes: Number(database?.bytes ?? 0) },
    jobs: {
      byStatus,
      recentFailures: failedJobs.map((job) => ({ ...job, error: shownError(job) })),
    },
    imports: {
      failed: failedImportCount?.count ?? 0,
      recentFailures: failedImports.map((item) => ({ ...item, error: shownError(item) })),
    },
    backup: {
      lastExport,
      latestExport: latestExport ?? null,
      lastIntegrityCheck: lastCheck,
      latestIntegrityCheck: latestCheck ?? null,
    },
  };
}
