import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { Decrypter } from "age-encryption";
import type { Database } from "@/infrastructure/database/client";
import type { StorageAdapter } from "@/infrastructure/storage";
import { AppError } from "@/lib/errors";
import { ageFormatOf, encryptStream, type EncryptionOptions } from "./encryption";
import { writeExport, type ExportSummary } from "./export";
import { removeIfInterrupted } from "./interrupt-cleanup";
import { manifestSummaryOf, sidecarOf } from "./sidecar";

/**
 * The operator CLI's side of export encryption (ADR-022, BACKUP_RECOVERY §4): an export
 * written straight into an age file, and an age file decrypted into a private temporary
 * file for restore. The plaintext archive never touches the disk on the way out; on the way
 * in it exists only in a fresh 0700 directory, as a 0600 file, until the restore ends.
 */

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The secret held by environment variable `name`, never one given on the command line
 * (`ps` shows every process's arguments). The variable is then removed from this process's
 * environment, so the processes it starts do not inherit it; the shell that set it keeps it
 * (set it in a subshell, BACKUP_RECOVERY §4). Something that is not a variable's name may be
 * the passphrase typed in its place, so it is never echoed.
 */
export function secretFromEnv(
  name: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (!ENV_NAME.test(name)) {
    throw new AppError(
      "VALIDATION_FAILED",
      "--passphrase-env takes the name of an environment variable (letters, digits, _), not the passphrase",
    );
  }
  const value = env[name];
  if (!value) throw new AppError("VALIDATION_FAILED", `Environment variable ${name} is not set`);
  delete env[name];
  return value;
}

/** Lines of an age key or recipients file: blanks and `#` comments skipped. */
function keyLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/** The recipients of an age recipients file (`age -R`), for `encryptionOptions` to check. */
export function recipientsFileFrom(text: string): string[] {
  return keyLines(text);
}

const X25519_IDENTITY = /^AGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58}$/;

/**
 * The X25519 identities of an age identity file (`age-keygen`'s output). Other kinds (plugin,
 * post-quantum, SSH) are refused by name: decrypt such a backup with `age -d` first.
 */
export function identitiesFrom(text: string): string[] {
  const identities = keyLines(text);
  if (identities.length === 0) {
    throw new AppError("VALIDATION_FAILED", "The identity file holds no age identity");
  }
  if (!identities.every((identity) => X25519_IDENTITY.test(identity))) {
    throw new AppError(
      "VALIDATION_FAILED",
      "The identity file holds a key other than an age X25519 identity (AGE-SECRET-KEY-1…); decrypt with age -d first",
    );
  }
  return identities;
}

/** Opens a file that must not exist yet, private to its owner. */
async function createPrivate(file: string): Promise<FileHandle> {
  try {
    return await open(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new AppError("CONFLICT", `${file} already exists; choose another --out`);
    }
    throw error;
  }
}

export interface ExportFileResult extends ExportSummary {
  out: string;
  /** Of the plaintext archive: what a decrypted copy must match. */
  sha256: string;
  byteSize: number;
  /** Where the sidecar was written, for an encrypted export. */
  sidecar: string | null;
}

/**
 * Writes `workspaceId`'s export to `out`, a new file (0600): the plain archive, or, with
 * `encryption`, the archive encrypted with age as it is written, beside its sidecar
 * `<out>.manifest.json`. Neither file may exist yet; on failure, what this call created is
 * removed and nothing else is touched.
 */
export async function exportToFile(
  db: Database,
  storage: StorageAdapter,
  workspaceId: string,
  out: string,
  encryption: EncryptionOptions | null,
): Promise<ExportFileResult> {
  const sidecarPath = encryption ? `${out}.manifest.json` : null;
  const archiveFile = await createPrivate(out);
  const releaseOut = removeIfInterrupted(out);
  let sidecarFile: FileHandle | null = null;
  let releaseSidecar = () => {};
  try {
    if (sidecarPath) {
      sidecarFile = await createPrivate(sidecarPath);
      releaseSidecar = removeIfInterrupted(sidecarPath);
    }
    const hash = createHash("sha256");
    let byteSize = 0;
    const counted = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        hash.update(chunk);
        byteSize += chunk.length;
        done(null, chunk);
      },
    });
    const written = encryption
      ? encryptStream(Readable.toWeb(counted) as ReadableStream<Uint8Array>, encryption).then(
          (encrypted) =>
            pipeline(
              Readable.fromWeb(encrypted as unknown as NodeReadableStream<Uint8Array>),
              archiveFile.createWriteStream({ flush: true }),
            ),
        )
      : pipeline(counted, archiveFile.createWriteStream({ flush: true }));
    // Whichever side fails first stops the other, so neither waits forever.
    const writing = written.catch((error: unknown) => {
      counted.destroy(error as Error);
      throw error;
    });
    const exporting = writeExport(db, storage, workspaceId, counted).catch((error: unknown) => {
      counted.destroy(error as Error);
      throw error;
    });
    const [settledExport, settledWrite] = await Promise.allSettled([exporting, writing]);
    if (settledExport.status === "rejected") throw settledExport.reason;
    if (settledWrite.status === "rejected") throw settledWrite.reason;
    const summary = settledExport.value;
    const sha256 = hash.digest("hex");
    if (sidecarFile) {
      const sidecar = sidecarOf({
        encryptedFilename: path.basename(out),
        archive: {
          filename: summary.filename,
          byteSize,
          sha256,
          formatVersion: summary.manifest.formatVersion,
        },
        manifest: manifestSummaryOf(summary.manifest),
      });
      await sidecarFile.writeFile(`${JSON.stringify(sidecar, null, 2)}\n`);
      await sidecarFile.sync();
      await sidecarFile.close();
    }
    return { ...summary, out, sha256, byteSize, sidecar: sidecarPath };
  } catch (error) {
    // Remove what this call created; a failure to do so never hides the reason it failed.
    await archiveFile.close().catch(() => undefined);
    await sidecarFile?.close().catch(() => undefined);
    await rm(out, { force: true }).catch(() => undefined);
    if (sidecarFile && sidecarPath) await rm(sidecarPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    releaseOut();
    releaseSidecar();
  }
}

/** Whether `file` is an age file, and which kind (`ageFormatOf`), from its first bytes. */
export async function ageFormatOfFile(file: string): Promise<"binary" | "armored" | null> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(64);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return ageFormatOf(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

export type DecryptionSecret = { passphrase: string } | { identities: string[] };

export interface DecryptedFile {
  /** The plaintext archive: a 0600 file in a fresh 0700 directory. */
  path: string;
  /** Removes the file and its directory. */
  dispose(): Promise<void>;
}

/**
 * Why decrypting into `dir` failed: the backup (wrong secret, damaged, truncated), or the
 * disk it was being written to (a system error such as ENOSPC, EACCES or EIO). /tmp is often
 * a RAM disk, too small for a large archive: an operator must not be told the backup is
 * damaged when the disk is full.
 */
export function decryptionFailure(error: unknown, dir: string, stage: "header" | "body"): Error {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof code === "string" && /^E[A-Z]+$/.test(code)) {
    return new Error(
      `Could not write the decrypted copy in ${path.dirname(dir)} (${code}): restoring an encrypted backup needs free space there for the whole archive; set TMPDIR to another directory`,
      { cause: error },
    );
  }
  // typage's reasons name no secret ("no identity matched any of the file's recipients").
  const details = { reason: error instanceof Error ? error.message : String(error) };
  return stage === "header"
    ? new AppError(
        "DECRYPTION_FAILED",
        "Could not decrypt the backup: wrong passphrase or identity, or not a file for them",
        { details },
      )
    : new AppError(
        "DECRYPTION_FAILED",
        "The encrypted backup is damaged or incomplete: it does not decrypt to the end",
        { details },
      );
}

/**
 * Decrypts the age file `file` into a private temporary file, for restore to read. A wrong
 * passphrase or identity is refused while reading the header, before the file is created; a
 * damaged or truncated file fails before the end (age authenticates every chunk and marks the
 * last). Nothing is left behind on failure, nor on SIGINT, SIGTERM or SIGHUP in a CLI
 * (`cleanUpOnInterrupt`). The caller disposes of the result once the restore has ended.
 */
export async function decryptToTempFile(
  file: string,
  secret: DecryptionSecret,
): Promise<DecryptedFile> {
  const format = await ageFormatOfFile(file);
  if (format === null) {
    throw new AppError("UNSUPPORTED_EXPORT_FORMAT", `${file} is not an age-encrypted file`);
  }
  if (format === "armored") {
    throw new AppError(
      "UNSUPPORTED_EXPORT_FORMAT",
      "ASCII-armored age files are not read here: decrypt with age -d first, then restore the .zip",
    );
  }
  const decrypter = new Decrypter();
  if ("passphrase" in secret) decrypter.addPassphrase(secret.passphrase);
  else for (const identity of secret.identities) decrypter.addIdentity(identity);

  const dir = await mkdtemp(path.join(tmpdir(), "vault-restore-"));
  const release = removeIfInterrupted(dir);
  const dispose = async () => {
    await rm(dir, { recursive: true, force: true });
    release();
  };
  const input = createReadStream(file);
  try {
    let plaintext;
    try {
      plaintext = await decrypter.decrypt(Readable.toWeb(input) as ReadableStream<Uint8Array>);
    } catch (error) {
      throw decryptionFailure(error, dir, "header");
    }
    const target = path.join(dir, "export.zip");
    const output = await createPrivate(target);
    try {
      await pipeline(
        Readable.fromWeb(plaintext as unknown as NodeReadableStream<Uint8Array>),
        output.createWriteStream({ flush: true }),
      );
    } catch (error) {
      throw decryptionFailure(error, dir, "body");
    }
    return { path: target, dispose };
  } catch (error) {
    input.destroy();
    await dispose();
    throw error;
  }
}
