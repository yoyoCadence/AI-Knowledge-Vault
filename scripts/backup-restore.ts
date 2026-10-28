/**
 * Restores a portable export into a workspace (BACKUP_RECOVERY §6).
 *
 *   pnpm backup:restore <archive.zip | archive.zip.age> --workspace <slug>
 *       [--mode skip_existing|copy] [--passphrase-env <VAR> | --identity-file <file>]
 *
 * An age-encrypted backup (§4) is decrypted first, with the passphrase in the environment
 * variable named (never on the command line) or the identities of an age identity file,
 * into a private temporary file that is removed when the restore ends. Every checksum is
 * verified before anything is written. Re-extraction of the restored versions runs in the
 * worker (`restore.reextract_version` jobs), so start the worker after.
 */
import { readFile } from "node:fs/promises";
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
import {
  ageFormatOfFile,
  decryptToTempFile,
  identitiesFrom,
  restoreArchive,
  restoreLimitsFromEnv,
  secretFromEnv,
  type DecryptedFile,
  type DecryptionSecret,
} from "@/modules/backup";
import { sha256OfFile } from "@/modules/files/hash";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      workspace: { type: "string" },
      mode: { type: "string" },
      "passphrase-env": { type: "string" },
      "identity-file": { type: "string" },
    },
  });
  const file = positionals[0];
  if (!file || !values.workspace) {
    throw new Error(
      "usage: backup:restore <archive.zip | archive.zip.age> --workspace <slug> [--mode skip_existing|copy] [--passphrase-env <VAR> | --identity-file <file>]",
    );
  }
  const secret = await secretFrom(values);
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

  const encrypted = (await ageFormatOfFile(file)) !== null;
  if (encrypted && !secret) {
    throw new Error(
      `${file} is encrypted with age: give --passphrase-env <VAR> or --identity-file <file>`,
    );
  }
  if (!encrypted && secret) throw new Error(`${file} is not encrypted; drop the secret`);
  const decrypted: DecryptedFile | null = secret ? await decryptToTempFile(file, secret) : null;
  try {
    await restore(decrypted?.path ?? file, workspace.id, owner?.userId ?? null, mode, env);
  } finally {
    await decrypted?.dispose();
  }
}

async function secretFrom(values: {
  "passphrase-env"?: string;
  "identity-file"?: string;
}): Promise<DecryptionSecret | null> {
  if (values["passphrase-env"] !== undefined && values["identity-file"] !== undefined) {
    throw new Error("use --passphrase-env or --identity-file, not both");
  }
  if (values["passphrase-env"] !== undefined) {
    return { passphrase: secretFromEnv(values["passphrase-env"]) };
  }
  if (values["identity-file"] !== undefined) {
    return { identities: identitiesFrom(await readFile(values["identity-file"], "utf8")) };
  }
  return null;
}

/** Restores the plain archive `file`, recording the run (its SHA-256 is the plaintext's). */
async function restore(
  file: string,
  workspaceId: string,
  userId: string | null,
  mode: RestoreMode,
  env: ReturnType<typeof getEnv>,
): Promise<void> {
  const db = getDb();
  const restoreId = newId();
  const { sha256 } = await sha256OfFile(file);
  await db.insert(restoreRuns).values({
    id: restoreId,
    workspaceId,
    requestedBy: userId,
    status: "running",
    sourceSha256: sha256,
    mode,
  });
  try {
    const report = await restoreArchive(db, getStorage(), {
      archivePath: file,
      workspaceId,
      userId,
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
