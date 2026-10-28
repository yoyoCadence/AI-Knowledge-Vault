import { EXPORT_FORMAT, type ManifestV4 } from "./format";

/** The part of a manifest an export run keeps, and a sidecar shows: no titles, no names. */
export function manifestSummaryOf(manifest: ManifestV4) {
  return {
    createdAt: manifest.createdAt,
    appVersion: manifest.appVersion,
    dbMigration: manifest.dbMigration,
    counts: manifest.counts,
  };
}

/**
 * The sidecar of an encrypted export (BACKUP_RECOVERY §4), the same from the web and the CLI:
 * what the archive holds, readable without decrypting it, so a set of backups can be
 * inventoried. It describes the plaintext archive (its SHA-256 checks the decrypted copy):
 * file name, size, format, when and by which app version it was made, and its counts. It
 * holds nothing secret, and not the workspace's name, which sits beside the backup in
 * whatever cloud it is kept.
 */
export function sidecarOf(input: {
  encryptedFilename: string;
  archive: { filename: string; byteSize: number; sha256: string; formatVersion: number };
  manifest: unknown;
}) {
  return {
    format: `${EXPORT_FORMAT}-sidecar`,
    sidecarVersion: 1,
    encrypted: { format: "age", filename: input.encryptedFilename },
    archive: input.archive,
    manifest: input.manifest,
  };
}
