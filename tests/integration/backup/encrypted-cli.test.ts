import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Decrypter, generateIdentity, identityToRecipient } from "age-encryption";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "@/infrastructure/database/client";
import { artifacts, workspaces } from "@/infrastructure/database/schema";
import { getStorage, type StorageAdapter } from "@/infrastructure/storage";
import {
  decryptToTempFile,
  exportToFile,
  restoreArchive,
  restoreLimitsFromEnv,
} from "@/modules/backup";
import { getEnv } from "@/infrastructure/config/env";
import type { Actor } from "@/modules/auth";
import { htmlDocument } from "@tests/fixtures/builders";
import { ageCli, ageDecryptWithIdentity, ageDecryptWithPassphrase } from "../helpers/age";
import { closeTestDb, testDb } from "../helpers/db";
import { createTestActor, drainJobs, newBatch, uploadFile } from "../helpers/imports";

/**
 * The operator CLI's encrypted backups (ADR-022, BACKUP_RECOVERY §4): `backup:export` writes
 * an age file and its sidecar; `backup:restore` decrypts one into a private temporary file and
 * restores it. The secret comes from an environment variable and appears nowhere else.
 */

const db = testDb();
const root = path.resolve(import.meta.dirname, "../../..");
const run = promisify(execFile);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const PASSPHRASE = "the operator's backup passphrase 51c9";
let dir: string;
let source: Actor;
let slug: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "vault-encrypted-cli-"));
  source = await createTestActor();
  const batch = await newBatch(source);
  for (const name of ["first", "second"]) {
    await uploadFile(source, batch.id, {
      filename: `${name}.html`,
      bytes: htmlDocument({ title: `備份 ${name}`, body: `<p>${name} 的內容。</p>` }),
    });
  }
  await drainJobs();
  slug = await slugOf(source.workspaceId);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await closeDb();
  await closeTestDb();
});

async function slugOf(workspaceId: string) {
  const [workspace] = await db
    .select({ slug: workspaces.slug })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  return workspace!.slug;
}

const workCount = async (workspaceId: string) =>
  (await db.select().from(artifacts).where(eq(artifacts.workspaceId, workspaceId))).length;

async function decryptedBy(file: string, add: (decrypter: Decrypter) => void) {
  const decrypter = new Decrypter();
  add(decrypter);
  return decrypter.decrypt(await readFile(file));
}

/** Files directly in `folder` whose names start with `prefix`. */
const entries = async (folder: string, prefix: string) =>
  (await readdir(folder)).filter((name) => name.startsWith(prefix));

describe("exportToFile (backup:export)", () => {
  it("writes the archive encrypted with a passphrase, and its sidecar, both private", async () => {
    const out = path.join(dir, "by-passphrase.zip.age");
    const result = await exportToFile(db, getStorage(), source.workspaceId, out, {
      kind: "passphrase",
      passphrase: PASSPHRASE,
    });
    expect(result.sidecar).toBe(`${out}.manifest.json`);
    for (const file of [out, result.sidecar!]) {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
    const plaintext = await decryptedBy(out, (d) => d.addPassphrase(PASSPHRASE));
    expect(sha256(plaintext)).toBe(result.sha256);
    expect(plaintext.length).toBe(result.byteSize);

    const sidecar = JSON.parse(await readFile(result.sidecar!, "utf8")) as Record<string, unknown>;
    expect(sidecar).toEqual({
      format: "ai-knowledge-vault-export-sidecar",
      sidecarVersion: 1,
      encrypted: { format: "age", filename: "by-passphrase.zip.age" },
      archive: {
        filename: result.filename,
        byteSize: result.byteSize,
        sha256: result.sha256,
        formatVersion: result.manifest.formatVersion,
      },
      manifest: {
        createdAt: result.manifest.createdAt,
        appVersion: result.manifest.appVersion,
        dbMigration: result.manifest.dbMigration,
        counts: result.manifest.counts,
      },
    });
    expect(JSON.stringify(sidecar)).not.toContain("備份");

    const age = ageCli();
    if (age) expect(await ageDecryptWithPassphrase(age, dir, out, PASSPHRASE)).toBe(result.sha256);
  });

  it("writes to recipients, which the age CLI decrypts with the identity", async () => {
    const identity = await generateIdentity();
    const out = path.join(dir, "to-recipient.zip.age");
    const result = await exportToFile(db, getStorage(), source.workspaceId, out, {
      kind: "recipients",
      recipients: [await identityToRecipient(identity)],
    });
    expect(sha256(await decryptedBy(out, (d) => d.addIdentity(identity)))).toBe(result.sha256);
    const age = ageCli();
    if (age) {
      const key = path.join(dir, "recipient-key.txt");
      await writeFile(key, `${identity}\n`, { mode: 0o600 });
      expect(await ageDecryptWithIdentity(age, dir, out, key)).toBe(result.sha256);
    }
  });

  it("writes a plain archive without encryption, and no sidecar", async () => {
    const out = path.join(dir, "plain.zip");
    const result = await exportToFile(db, getStorage(), source.workspaceId, out, null);
    expect(result.sidecar).toBeNull();
    expect(sha256(await readFile(out))).toBe(result.sha256);
    expect(await entries(dir, "plain.zip")).toEqual(["plain.zip"]);
  });

  it("never overwrites: an existing file, or sidecar, is left as it was", async () => {
    const out = path.join(dir, "existing.zip.age");
    await writeFile(out, "the owner's other file");
    await expect(
      exportToFile(db, getStorage(), source.workspaceId, out, {
        kind: "passphrase",
        passphrase: PASSPHRASE,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readFile(out, "utf8")).toBe("the owner's other file");

    const fresh = path.join(dir, "fresh.zip.age");
    await writeFile(`${fresh}.manifest.json`, "another sidecar");
    await expect(
      exportToFile(db, getStorage(), source.workspaceId, fresh, {
        kind: "passphrase",
        passphrase: PASSPHRASE,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readFile(`${fresh}.manifest.json`, "utf8")).toBe("another sidecar");
    expect(await entries(dir, "fresh.zip.age")).toEqual(["fresh.zip.age.manifest.json"]);
  });

  it("leaves nothing behind when the export fails part way", async () => {
    const storage = getStorage();
    const failing: StorageAdapter = Object.create(storage, {
      getObject: { value: () => Promise.reject(new Error("storage went away")) },
    });
    const out = path.join(dir, "failed.zip.age");
    await expect(
      exportToFile(db, failing, source.workspaceId, out, {
        kind: "passphrase",
        passphrase: PASSPHRASE,
      }),
    ).rejects.toThrow(/storage went away/);
    expect(await entries(dir, "failed.zip.age")).toEqual([]);
  });
});

describe("decryptToTempFile (backup:restore)", () => {
  let encrypted: string;
  let plainSha256: string;
  let tmp: string;
  const savedTmpdir = process.env.TMPDIR;
  beforeAll(async () => {
    encrypted = path.join(dir, "to-restore.zip.age");
    ({ sha256: plainSha256 } = await exportToFile(db, getStorage(), source.workspaceId, encrypted, {
      kind: "passphrase",
      passphrase: PASSPHRASE,
    }));
    // A temporary directory of our own, to see what decrypting leaves in it.
    tmp = path.join(dir, "tmp");
    await mkdir(tmp);
    process.env.TMPDIR = tmp;
  });
  afterAll(() => {
    if (savedTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmpdir;
  });

  it("decrypts into a 0600 file in a fresh 0700 directory, removed afterwards", async () => {
    const decrypted = await decryptToTempFile(encrypted, { passphrase: PASSPHRASE });
    expect(path.dirname(path.dirname(decrypted.path))).toBe(tmp);
    expect((await stat(decrypted.path)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(decrypted.path))).mode & 0o777).toBe(0o700);
    expect(sha256(await readFile(decrypted.path))).toBe(plainSha256);

    // …and it restores, into another workspace.
    const target = await createTestActor();
    const report = await restoreArchive(db, getStorage(), {
      archivePath: decrypted.path,
      workspaceId: target.workspaceId,
      userId: target.userId,
      mode: "skip_existing",
      restoreId: crypto.randomUUID(),
      limits: restoreLimitsFromEnv(getEnv()),
    });
    expect(report.failures).toEqual([]);
    expect(await workCount(target.workspaceId)).toBe(await workCount(source.workspaceId));

    await decrypted.dispose();
    expect(await readdir(tmp)).toEqual([]);
  });

  it("refuses the wrong passphrase or identity before writing, and leaves nothing", async () => {
    await expect(
      decryptToTempFile(encrypted, { passphrase: "not the passphrase at all" }),
    ).rejects.toMatchObject({ code: "DECRYPTION_FAILED", message: /wrong passphrase/ });
    await expect(
      decryptToTempFile(encrypted, { identities: [await generateIdentity()] }),
    ).rejects.toMatchObject({ code: "DECRYPTION_FAILED" });
    expect(await readdir(tmp)).toEqual([]);
  });

  it("refuses a truncated file, removing what it had decrypted", async () => {
    const cut = path.join(dir, "truncated.zip.age");
    await writeFile(cut, await readFile(encrypted));
    await truncate(cut, (await stat(cut)).size - 100);
    await expect(decryptToTempFile(cut, { passphrase: PASSPHRASE })).rejects.toMatchObject({
      code: "DECRYPTION_FAILED",
      message: /damaged or incomplete/,
    });
    expect(await readdir(tmp)).toEqual([]);
  });

  it("refuses files it does not read: armored age, and not age at all", async () => {
    const armored = path.join(dir, "armored.age");
    await writeFile(armored, "-----BEGIN AGE ENCRYPTED FILE-----\nYWdl\n");
    await expect(decryptToTempFile(armored, { passphrase: PASSPHRASE })).rejects.toMatchObject({
      code: "UNSUPPORTED_EXPORT_FORMAT",
      message: /age -d first/,
    });
    const plain = path.join(dir, "plain.zip");
    await expect(decryptToTempFile(plain, { passphrase: PASSPHRASE })).rejects.toMatchObject({
      code: "UNSUPPORTED_EXPORT_FORMAT",
    });
    expect(await readdir(tmp)).toEqual([]);
  });
});

describe("the scripts (pnpm backup:export / backup:restore)", () => {
  const tsx = path.join(root, "node_modules/.bin/tsx");
  const cli = (script: string, args: string[], env: Record<string, string> = {}) =>
    run(tsx, [path.join(root, "scripts", script), ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      timeout: 120_000,
    }).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (error: { code?: number; stdout?: string; stderr?: string }) => ({
        code: error.code ?? 1,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
      }),
    );

  it("export → restore with a passphrase from the environment, never echoed", async () => {
    const folder = await mkdtemp(path.join(dir, "scripts-"));
    const out = path.join(folder, "backup.zip.age");
    const secretEnv = { VAULT_TEST_BACKUP_PASSPHRASE: PASSPHRASE };

    const exported = await cli(
      "backup-export.ts",
      ["--workspace", slug, "--out", out, "--passphrase-env", "VAULT_TEST_BACKUP_PASSPHRASE"],
      secretEnv,
    );
    expect(exported, exported.stderr).toMatchObject({ code: 0 });
    expect(exported.stdout).toContain("encrypted with age (passphrase)");
    expect(await readdir(folder)).toEqual(["backup.zip.age", "backup.zip.age.manifest.json"]);
    // The secret is in no output and no file; only the encrypted file depends on it.
    expect(`${exported.stdout}${exported.stderr}`).not.toContain(PASSPHRASE);
    expect(await readFile(`${out}.manifest.json`, "utf8")).not.toContain(PASSPHRASE);
    expect((await readFile(out)).includes(Buffer.from(PASSPHRASE))).toBe(false);

    const target = await createTestActor();
    const targetSlug = await slugOf(target.workspaceId);

    // Without the secret, or with the wrong one: refused, nothing restored.
    const withoutSecret = await cli("backup-restore.ts", [out, "--workspace", targetSlug]);
    expect(withoutSecret.code).toBe(1);
    expect(withoutSecret.stderr).toContain("--passphrase-env");
    const wrong = await cli(
      "backup-restore.ts",
      [out, "--workspace", targetSlug, "--passphrase-env", "VAULT_TEST_BACKUP_PASSPHRASE"],
      { VAULT_TEST_BACKUP_PASSPHRASE: "a wrong passphrase, typed in haste" },
    );
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain("Could not decrypt");
    expect(wrong.stderr).not.toContain("a wrong passphrase");
    expect(await workCount(target.workspaceId)).toBe(0);

    const restored = await cli(
      "backup-restore.ts",
      [out, "--workspace", targetSlug, "--passphrase-env", "VAULT_TEST_BACKUP_PASSPHRASE"],
      secretEnv,
    );
    expect(restored, restored.stderr).toMatchObject({ code: 0 });
    expect(`${restored.stdout}${restored.stderr}`).not.toContain(PASSPHRASE);
    expect(await workCount(target.workspaceId)).toBe(await workCount(source.workspaceId));
    // The run records the plaintext's SHA-256, as for a plain archive.
    const sidecar = JSON.parse(await readFile(`${out}.manifest.json`, "utf8")) as {
      archive: { sha256: string };
    };
    const { rows } = await db.execute<{ source_sha256: string }>(
      sql`select source_sha256 from restore_runs where workspace_id = ${target.workspaceId}
          and status = 'completed'`,
    );
    expect(rows.map((row) => row.source_sha256)).toEqual([sidecar.archive.sha256]);
  });

  it("refuses a passphrase given with recipients, and an unset variable, before any work", async () => {
    const folder = await mkdtemp(path.join(dir, "refusals-"));
    const recipient = await identityToRecipient(await generateIdentity());
    const both = await cli(
      "backup-export.ts",
      [
        "--workspace",
        slug,
        "--out",
        path.join(folder, "x.zip.age"),
        "--passphrase-env",
        "VAULT_TEST_BACKUP_PASSPHRASE",
        "--recipient",
        recipient,
      ],
      { VAULT_TEST_BACKUP_PASSPHRASE: PASSPHRASE },
    );
    expect(both.code).toBe(1);
    expect(both.stderr).toContain("not both");
    const unset = await cli("backup-export.ts", [
      "--workspace",
      slug,
      "--out",
      path.join(folder, "x.zip.age"),
      "--passphrase-env",
      "VAULT_TEST_UNSET_VARIABLE",
    ]);
    expect(unset.code).toBe(1);
    expect(unset.stderr).toContain("VAULT_TEST_UNSET_VARIABLE is not set");
    expect(await readdir(folder)).toEqual([]);
  });
});
