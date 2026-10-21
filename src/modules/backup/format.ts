import { z } from "zod";
import {
  ARTIFACT_FILE_ROLES,
  CONTENT_KINDS,
  PREVIEW_KINDS,
  PROJECT_STATUSES,
  REVIEW_STATUSES,
  SENSITIVITIES,
  VISIBILITIES,
} from "@/infrastructure/database/schema";

/**
 * Portable export format (docs/BACKUP_RECOVERY.md §2). Pure definitions shared by export and
 * restore: entry paths, Zod schemas for every JSON file, and the `checksums.sha256` codec
 * (GNU coreutils format, so `sha256sum -c checksums.sha256` verifies an archive without the app).
 *
 * Versions: v1 is the original layout; v2 adds `metadata/tags.json` and
 * `metadata/artifact_tags.json`. Exports are written as the latest version; restore reads every
 * supported one. An app that only knows v1 refuses a v2 archive instead of silently dropping
 * its tags.
 */

export const EXPORT_FORMAT = "ai-knowledge-vault-export";
export const EXPORT_FORMAT_VERSION = 2;
export const SUPPORTED_FORMAT_VERSIONS = [1, 2] as const;
export type FormatVersion = (typeof SUPPORTED_FORMAT_VERSIONS)[number];

export const PATHS = {
  readme: "README.txt",
  manifest: "manifest.json",
  schemaVersion: "schema-version.json",
  checksums: "checksums.sha256",
  workspace: "metadata/workspace.json",
  projects: "metadata/research_projects.json",
  artifacts: "metadata/artifacts.json",
  versions: "metadata/artifact_versions.json",
  fileAssets: "metadata/file_assets.json",
  artifactFiles: "metadata/artifact_files.json",
  /** v2+ */
  tags: "metadata/tags.json",
  /** v2+ */
  artifactTags: "metadata/artifact_tags.json",
} as const;

const SHA256 = /^[0-9a-f]{64}$/;
const sha256 = z.string().regex(SHA256);
const id = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
const nullableText = z.string().nullable();

export function normalizedPath(versionId: string): string {
  return `normalized/${id.parse(versionId)}.md`;
}

/** Keeps the original name readable while making it a single, safe path segment. */
export function sanitizeArchiveFilename(filename: string): string {
  const replaced = filename
    .normalize("NFC")
    // Control characters, slashes, backslashes and lone surrogates (which ZIP and
    // checksums.sha256 would encode differently from the JSON metadata) are replaced.
    .replace(/[\u0000-\u001f\u007f/\\]|\p{Cs}/gu, "_")
    .replace(/^\.+/, "_")
    .trim();
  // Truncate by code point, never inside a surrogate pair.
  const cleaned = Array.from(replaced).slice(0, 200).join("");
  return cleaned.length > 0 ? cleaned : "original";
}

export function originalPath(contentSha256: string, filename: string): string {
  const hash = sha256.parse(contentSha256);
  return `originals/${hash.slice(0, 2)}/${hash}/${sanitizeArchiveFilename(filename)}`;
}

/** The content hash embedded in an `originals/…` path, or null for any other path. */
export function hashFromOriginalPath(path: string): string | null {
  const match = /^originals\/([0-9a-f]{2})\/([0-9a-f]{64})\/[^/]+$/.exec(path);
  return match && match[2]!.startsWith(match[1]!) ? match[2]! : null;
}

export function exportFilename(workspaceSlug: string, createdAt: Date): string {
  const stamp = createdAt
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  return `knowledge-vault-export-${workspaceSlug}-${stamp}.zip`;
}

// ---------- JSON schemas ----------

const count = z.number().int().nonnegative();

export const ManifestV1 = z.object({
  format: z.literal(EXPORT_FORMAT),
  formatVersion: z.literal(1),
  createdAt: timestamp,
  appVersion: z.string().max(50),
  dbMigration: z.string().max(200),
  encryption: z.literal("none"),
  workspace: z.object({ id, name: z.string(), slug: z.string() }),
  counts: z.object({
    researchProjects: count,
    artifacts: count,
    artifactVersions: count,
    fileAssets: count,
    artifactFiles: count,
    normalizedDocuments: count,
  }),
  /** SHA-256 of `checksums.sha256`, which in turn covers every other entry. */
  checksumsSha256: sha256,
});
export type ManifestV1 = z.infer<typeof ManifestV1>;

export const ManifestV2 = ManifestV1.extend({
  formatVersion: z.literal(2),
  counts: ManifestV1.shape.counts.extend({ tags: count, artifactTags: count }),
});
export type ManifestV2 = z.infer<typeof ManifestV2>;

/** The manifest of any supported version, told apart by `formatVersion`. */
export const Manifest = z.discriminatedUnion("formatVersion", [ManifestV1, ManifestV2]);
export type Manifest = z.infer<typeof Manifest>;

export const SchemaVersion = z.object({
  format: z.literal(EXPORT_FORMAT),
  formatVersion: z.union([z.literal(1), z.literal(2)]),
  dbMigration: z.string().max(200),
});

export const WorkspaceV1 = z.object({ id, name: z.string(), slug: z.string() });

export const ProjectV1 = z.object({
  id,
  title: z.string(),
  description: nullableText,
  status: z.enum(PROJECT_STATUSES),
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: timestamp.nullable(),
});
export type ProjectV1 = z.infer<typeof ProjectV1>;

export const ArtifactV1 = z.object({
  id,
  projectId: id.nullable(),
  title: z.string(),
  description: nullableText,
  summary: nullableText,
  visibility: z.enum(VISIBILITIES),
  sensitivity: z.enum(SENSITIVITIES),
  reviewStatus: z.enum(REVIEW_STATUSES),
  identityKey: nullableText,
  currentVersionId: id.nullable(),
  originRef: nullableText,
  metadata: z.record(z.string(), z.unknown()),
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: timestamp.nullable(),
});
export type ArtifactV1 = z.infer<typeof ArtifactV1>;

export const ReferenceV1 = z.object({
  title: z.string().nullish(),
  url: z.string(),
});

export const VersionV1 = z.object({
  id,
  artifactId: id,
  versionNumber: z.number().int().min(1),
  primaryFileId: id,
  contentKind: z.enum(CONTENT_KINDS),
  previewKind: z.enum(PREVIEW_KINDS),
  previewEntryPath: nullableText,
  contentHash: sha256.nullable(),
  sourcePlatform: nullableText,
  sourceModel: nullableText,
  originalPrompt: nullableText,
  sourceUrl: nullableText,
  researchDate: z.iso.date().nullable(),
  author: nullableText,
  referenceSources: z.array(ReferenceV1),
  changeSummary: nullableText,
  analysis: z.record(z.string(), z.unknown()),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type VersionV1 = z.infer<typeof VersionV1>;

export const FileAssetV1 = z.object({
  id,
  sha256,
  byteSize: z.number().int().nonnegative(),
  mimeType: z.string(),
  originalFilename: z.string(),
  archivePath: z.string(),
  createdAt: timestamp,
});
export type FileAssetV1 = z.infer<typeof FileAssetV1>;

export const ArtifactFileV1 = z.object({
  id,
  artifactVersionId: id,
  fileAssetId: id,
  role: z.enum(ARTIFACT_FILE_ROLES),
  displayName: z.string(),
  createdAt: timestamp,
});
export type ArtifactFileV1 = z.infer<typeof ArtifactFileV1>;

export const TagV2 = z.object({
  id,
  name: z.string().min(1).max(200),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type TagV2 = z.infer<typeof TagV2>;

export const ArtifactTagV2 = z.object({ artifactId: id, tagId: id, createdAt: timestamp });
export type ArtifactTagV2 = z.infer<typeof ArtifactTagV2>;

// ---------- checksums.sha256 ----------

export interface ChecksumEntry {
  path: string;
  sha256: string;
}

/** True for paths `sha256sum` can represent without escaping and that are safe to restore. */
export function isPortablePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 1024 &&
    !path.startsWith("/") &&
    // Newlines and other control characters would break the line-based format.
    !/[\u0000-\u001f\u007f\\]/.test(path) &&
    !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  );
}

export function formatChecksums(entries: ChecksumEntry[]): string {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sorted
    .map((entry) => {
      if (!SHA256.test(entry.sha256)) throw new Error(`invalid sha256 for ${entry.path}`);
      if (!isPortablePath(entry.path)) throw new Error(`non-portable archive path ${entry.path}`);
      return `${entry.sha256}  ${entry.path}\n`;
    })
    .join("");
}

export class ChecksumFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChecksumFormatError";
  }
}

/** Strict parser: every line must be `<64 hex>  <path>` (or the `*` binary marker). */
export function parseChecksums(text: string): Map<string, string> {
  const result = new Map<string, string>();
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const [index, line] of lines.entries()) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!match) throw new ChecksumFormatError(`line ${index + 1} is not "<sha256>  <path>"`);
    const [, hash, path] = match as unknown as [string, string, string];
    if (!isPortablePath(path)) throw new ChecksumFormatError(`line ${index + 1}: unsafe path`);
    if (result.has(path)) throw new ChecksumFormatError(`duplicate entry for ${path}`);
    result.set(path, hash);
  }
  return result;
}

export const README_TEXT = `AI Knowledge Vault — portable export (format version ${EXPORT_FORMAT_VERSION})
AI 知識庫可攜式匯出（格式第 ${EXPORT_FORMAT_VERSION} 版）

This archive is readable without the application.

  manifest.json          format, creation time, app version, entry counts, and the SHA-256 of
                         checksums.sha256
  schema-version.json    format version and the database migration it was exported from
  metadata/*.json        one JSON array per table; field names match the application's model
    workspace.json            {id, name, slug}
    research_projects.json    research projects
    artifacts.json            artifacts (title, summary, visibility, current version, …)
    artifact_versions.json    versions (source platform/model/url, research date, references, …)
    file_assets.json          originals: sha256, size, MIME type, original filename, archivePath
    artifact_files.json       which original belongs to which version
    tags.json                 tags {id, name}
    artifact_tags.json        which artifact carries which tag {artifactId, tagId}
  originals/<aa>/<sha256>/<filename>
                         the untouched original files; <sha256> is the hash of the bytes
  normalized/<version-id>.md
                         extracted text as Markdown, with YAML front matter (title, artifact,
                         version, language, extraction method)
  checksums.sha256       SHA-256 of every entry except itself and manifest.json (the manifest
                         records the SHA-256 of checksums.sha256, so together they cover all)

Verify the archive:   unzip export.zip -d export && cd export && sha256sum -c checksums.sha256
Restore it:           pnpm backup:restore <archive> --workspace <slug>   (docs/BACKUP_RECOVERY.md)

This archive is NOT encrypted. Encrypt it before storing it anywhere shared, for example:
  age --passphrase -o export.zip.age export.zip
It contains no passwords, sessions or share-link tokens.
`;
