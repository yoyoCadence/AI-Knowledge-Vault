/**
 * Restores a portable export into a workspace (BACKUP_RECOVERY §6).
 *
 *   pnpm backup:restore ./knowledge-vault-export.zip --workspace <slug> [--mode skip_existing|copy]
 *
 * Every checksum is verified before anything is written. Re-extraction of the restored
 * versions runs in the worker (`restore.reextract_version` jobs), so start the worker after.
 */
import { parseArgs } from "node:util";
import { and, eq } from "drizzle-orm";
import { getEnv } from "@/infrastructure/config/env";
import { closeDb, getDb } from "@/infrastructure/database/client";
import {
  RESTORE_MODES,
  restoreRuns,
  workspaceMembers,
  workspaces,
  type RestoreMode,
} from "@/infrastructure/database/schema";
import { getStorage } from "@/infrastructure/storage";
import { isAppError } from "@/lib/errors";
import { newId } from "@/lib/ids";
import { restoreArchive, restoreLimitsFromEnv } from "@/modules/backup";
import { sha256OfFile } from "@/modules/files/hash";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { workspace: { type: "string" }, mode: { type: "string" } },
  });
  const file = positionals[0];
  if (!file || !values.workspace) {
    throw new Error(
      "usage: backup:restore <archive.zip> --workspace <slug> [--mode skip_existing|copy]",
    );
  }
  const mode = (values.mode ?? "skip_existing") as RestoreMode;
  if (!RESTORE_MODES.includes(mode))
    throw new Error(`--mode must be one of ${RESTORE_MODES.join(", ")}`);
  const env = getEnv();
  const db = getDb();
  const [workspace] = await db
    .select({ id: workspaces.id, slug: workspaces.slug })
    .from(workspaces)
    .where(eq(workspaces.slug, values.workspace));
  if (!workspace)
    throw new Error(`workspace "${values.workspace}" not found (run admin:create first)`);
  const [owner] = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspace.id), eq(workspaceMembers.role, "owner")));

  const restoreId = newId();
  const { sha256 } = await sha256OfFile(file);
  await db.insert(restoreRuns).values({
    id: restoreId,
    workspaceId: workspace.id,
    requestedBy: owner?.userId ?? null,
    status: "running",
    sourceSha256: sha256,
    mode,
  });
  try {
    const report = await restoreArchive(db, getStorage(), {
      archivePath: file,
      workspaceId: workspace.id,
      userId: owner?.userId ?? null,
      mode,
      restoreId,
      limits: restoreLimitsFromEnv(env),
    });
    await db
      .update(restoreRuns)
      .set({ status: "completed", report: { ...report }, completedAt: new Date() })
      .where(eq(restoreRuns.id, restoreId));
    console.log(JSON.stringify({ restoreId, ...report, idMap: undefined }, null, 2));
    console.log(
      `Queued ${report.reextractJobs} re-extraction job(s); start the worker to rebuild.`,
    );
    if (report.failures.length > 0) process.exitCode = 2;
  } catch (error) {
    await db
      .update(restoreRuns)
      .set({
        status: "failed",
        errorCode: isAppError(error) ? error.code : "INTERNAL_ERROR",
        errorMessage: error instanceof Error ? error.message.slice(0, 1000) : String(error),
        report: isAppError(error) && error.details ? { details: error.details } : null,
        completedAt: new Date(),
      })
      .where(eq(restoreRuns.id, restoreId));
    throw error;
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    if (isAppError(error) && error.details) console.error(JSON.stringify(error.details, null, 2));
    process.exitCode = 1;
  })
  .finally(() => closeDb());
