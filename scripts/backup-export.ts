/**
 * Writes a portable export of one workspace to a new local file (BACKUP_RECOVERY §3),
 * encrypted with age when asked (§4, ADR-022):
 *
 *   pnpm backup:export --workspace <slug> [--out <file>]
 *       [--passphrase-env <VAR> | --recipient age1… (repeatable) | --recipients-file <file>]
 *
 * A passphrase is read from the environment variable named, never from the command line,
 * which `ps` shows to every user: `read -rs VAULT_BACKUP_PASSPHRASE; export
 * VAULT_BACKUP_PASSPHRASE`, then `--passphrase-env VAULT_BACKUP_PASSPHRASE`. An encrypted
 * export gets its sidecar beside it (`<out>.manifest.json`). Without any of these options the
 * archive is NOT encrypted.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { getEnv } from "@/infrastructure/config/env";
import { closeDb, getDb } from "@/infrastructure/database/client";
import { workspaces } from "@/infrastructure/database/schema";
import { getStorage } from "@/infrastructure/storage";
import {
  encryptionOptions,
  exportToFile,
  recipientsFileFrom,
  secretFromEnv,
  type EncryptionOptions,
} from "@/modules/backup";

async function encryptionFrom(values: {
  "passphrase-env"?: string;
  recipient?: string[];
  "recipients-file"?: string;
}): Promise<EncryptionOptions | null> {
  const recipients = [
    ...(values.recipient ?? []),
    ...(values["recipients-file"]
      ? recipientsFileFrom(await readFile(values["recipients-file"], "utf8"))
      : []),
  ];
  const asked = values["recipients-file"] !== undefined || recipients.length > 0;
  if (values["passphrase-env"] !== undefined && asked) {
    throw new Error("use --passphrase-env or recipients, not both");
  }
  if (values["passphrase-env"] !== undefined) {
    return encryptionOptions({ passphrase: secretFromEnv(values["passphrase-env"]) });
  }
  return asked ? encryptionOptions({ recipients }) : null;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      workspace: { type: "string" },
      out: { type: "string" },
      "passphrase-env": { type: "string" },
      recipient: { type: "string", multiple: true },
      "recipients-file": { type: "string" },
    },
  });
  if (!values.workspace) throw new Error("--workspace <slug> is required");
  const encryption = await encryptionFrom(values);
  getEnv();
  const db = getDb();
  const [workspace] = await db
    .select({ id: workspaces.id, slug: workspaces.slug })
    .from(workspaces)
    .where(eq(workspaces.slug, values.workspace));
  if (!workspace) throw new Error(`workspace "${values.workspace}" not found`);
  const out =
    values.out ?? `./knowledge-vault-export-${workspace.slug}.zip${encryption ? ".age" : ""}`;
  const result = await exportToFile(db, getStorage(), workspace.id, out, encryption);
  console.log(`Exported workspace "${workspace.slug}" to ${out}`);
  console.log(`  archive: ${result.byteSize} bytes, sha256 ${result.sha256}`);
  console.log(`  ${JSON.stringify(result.manifest.counts)}`);
  if (encryption) {
    console.log(
      `  encrypted with age (${encryption.kind === "passphrase" ? "passphrase" : `${encryption.recipients.length} recipient(s)`}); sidecar ${result.sidecar}`,
    );
    console.log(`  decrypt: age -d -o export.zip ${out}   (then check the sha256 above)`);
  } else {
    console.log("  WARNING: the archive is not encrypted (see --passphrase-env, --recipient).");
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
