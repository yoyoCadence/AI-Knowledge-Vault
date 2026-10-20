/**
 * Writes a portable export (format v1) of one workspace to a local file (BACKUP_RECOVERY §3).
 *
 *   pnpm backup:export --workspace <slug> --out ./knowledge-vault-export.zip
 *
 * The archive is NOT encrypted; encrypt it before storing it anywhere shared (see §4).
 */
import { createWriteStream } from "node:fs";
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { getEnv } from "@/infrastructure/config/env";
import { closeDb, getDb } from "@/infrastructure/database/client";
import { workspaces } from "@/infrastructure/database/schema";
import { getStorage } from "@/infrastructure/storage";
import { writeExport } from "@/modules/backup";
import { sha256OfFile } from "@/modules/files/hash";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { workspace: { type: "string" }, out: { type: "string" } },
  });
  if (!values.workspace) throw new Error("--workspace <slug> is required");
  getEnv();
  const db = getDb();
  const [workspace] = await db
    .select({ id: workspaces.id, slug: workspaces.slug })
    .from(workspaces)
    .where(eq(workspaces.slug, values.workspace));
  if (!workspace) throw new Error(`workspace "${values.workspace}" not found`);
  const out = values.out ?? `./knowledge-vault-export-${workspace.slug}.zip`;
  const { manifest } = await writeExport(
    db,
    getStorage(),
    workspace.id,
    createWriteStream(out, { flags: "wx", mode: 0o600 }),
  );
  const { sha256, size } = await sha256OfFile(out);
  console.log(`Exported workspace "${workspace.slug}" to ${out}`);
  console.log(`  ${size} bytes, sha256 ${sha256}`);
  console.log(`  ${JSON.stringify(manifest.counts)}`);
  console.log("  WARNING: the archive is not encrypted (age --passphrase -o export.zip.age …).");
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
