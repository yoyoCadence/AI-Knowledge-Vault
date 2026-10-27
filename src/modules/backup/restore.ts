import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Database, DbExecutor } from "@/infrastructure/database/client";
import {
  artifactFiles,
  artifactNotes,
  artifactReadingStates,
  artifacts,
  artifactTags,
  artifactVersions,
  COLLECTION_MAX_DEPTH,
  collectionItems,
  collections,
  fileAssets,
  researchProjects,
  type RestoreMode,
  tags,
} from "@/infrastructure/database/schema";
import type { StorageAdapter } from "@/infrastructure/storage";
import { AppError, isAppError } from "@/lib/errors";
import { newId } from "@/lib/ids";
import {
  collectionDepth,
  lockCollectionTree,
  normalizeCollectionDescription,
  normalizeCollectionName,
} from "@/modules/collections";
import { SafeZip, ZipRejectedError, type ZipLimits } from "@/modules/extraction";
import { storeOriginal } from "@/modules/files/originals";
import { deterministicId, saveExtraction } from "@/modules/imports/derive";
import { enqueueJob } from "@/modules/jobs";
import { normalizeNoteBody, NOTES_PER_ARTIFACT_MAX } from "@/modules/notes";
import { enqueueVersionIndex, indexArtifactMetadata } from "@/modules/search/indexer";
import { normalizeTagName } from "@/modules/tags";
import {
  ArtifactFileV1,
  ArtifactTagV2,
  ArtifactV1,
  ChecksumFormatError,
  CollectionItemV3,
  CollectionV3,
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  FileAssetV1,
  hashFromOriginalPath,
  type Manifest,
  ManifestV1,
  ManifestV2,
  ManifestV3,
  ManifestV4,
  normalizedPath,
  NoteV4,
  parseChecksums,
  PATHS,
  ProjectV1,
  ReadingStateV4,
  SchemaVersion,
  SUPPORTED_FORMAT_VERSIONS,
  TagV2,
  VersionV1,
} from "./format";

/**
 * Restore of a format v1–v4 archive into a workspace (docs/BACKUP_RECOVERY.md §6).
 *
 * Order matters for safety:
 * 1. The archive is opened with the same SafeZip defences as imports.
 * 2. **Every** entry is hashed and compared with `checksums.sha256` (itself pinned by the
 *    manifest) before anything is written. Any mismatch aborts with CHECKSUM_MISMATCH.
 * 3. Metadata is schema-validated and cross-checked (every reference resolves).
 * 4. Originals are written content-addressed (idempotent), then rows are inserted one artifact
 *    per transaction, so a failure affects only that artifact and is reported.
 *
 * `skip_existing`: IDs are kept when free (restore into a clean environment reproduces the source
 * exactly); an artifact that already exists in the target workspace is skipped, and rows whose
 * IDs are taken by *another* workspace are restored under IDs derived from the target workspace.
 * `copy`: every row is restored under an ID derived from the restore run, so the archive is
 * duplicated even when it is already present. Both are deterministic, so a retried attempt of
 * the same run finds what an earlier attempt inserted instead of inserting it again.
 *
 * Derived data (sections, previews, thumbnails) is rebuilt by `restore.reextract_version` jobs;
 * the archived Markdown is available immediately as a fallback extraction.
 *
 * `signal` (the job's timeout) is checked before every entry, original, project and artifact:
 * once it fires, the artifact transaction in flight may still commit, but nothing new starts.
 */

export const REEXTRACT_JOB_TYPE = "restore.reextract_version";
export const RESTORE_EXTRACTION_METHOD = "restore_archive";
const COPY_SUFFIX = "（還原副本）";
const MAX_METADATA_BYTES = 256 * 1024 * 1024;
const MAX_LISTED_PROBLEMS = 50;

export type RestoreLimits = ZipLimits;

type Outcome = "restored" | "skipped" | "copied" | "failed";
const SUPPORTED: readonly number[] = SUPPORTED_FORMAT_VERSIONS;
type Tally = Record<Outcome, number>;
const tally = (): Tally => ({ restored: 0, skipped: 0, copied: 0, failed: 0 });

export interface RestoreReport {
  source: {
    formatVersion: number;
    appVersion: string;
    dbMigration: string;
    createdAt: string;
    workspace: Manifest["workspace"];
  };
  checksums: { verified: number };
  counts: {
    researchProjects: Tally;
    artifacts: Tally;
    artifactVersions: Tally;
    /** stored: new originals; reused: already present by hash; repaired: object re-written. */
    fileAssets: { stored: number; reused: number; repaired: number };
    /** skipped: merged into the target's tag of the same name (or the same tag). v2 only. */
    tags: Tally;
    /** Tag links written for newly restored artifacts. */
    artifactTags: number;
    /**
     * Archived tag links an artifact that already existed does not have. They are not added:
     * the artifact keeps its current tags (a tag removed since the export stays removed).
     */
    artifactTagsKept: number;
    /** Links not restored because their tag was deleted or merged while the restore ran. */
    artifactTagsDropped: number;
    /**
     * skipped: merged into the target's collection with the same place and name (or the same
     * collection). failed: could not be placed (see the warnings). v3 only.
     */
    collections: Tally;
    /** Collection items written for newly restored artifacts. */
    collectionItems: number;
    /** Archived items an artifact that already existed is not in; not added (as for tags). */
    collectionItemsKept: number;
    /** Items not restored because their collection was not restored or was deleted meanwhile. */
    collectionItemsDropped: number;
    /**
     * Notes, with new artifacts and also those an existing artifact lacks (like versions):
     * skipped means the note already exists. v4 only.
     */
    notes: Tally;
    /** Reading states given to the restoring user, for newly restored artifacts. v4 only. */
    readingStates: number;
  };
  /** Old → new ids for everything restored under a new id (capped). */
  idMap: Record<string, string>;
  failures: { artifactId: string; title: string; error: string }[];
  warnings: string[];
  reextractJobs: number;
  durationMs: number;
}

function checksumMismatch(message: string, files: string[]): AppError {
  return new AppError("CHECKSUM_MISMATCH", message, {
    details: { files: files.slice(0, MAX_LISTED_PROBLEMS), total: files.length },
    retryable: false,
  });
}

function invalidArchive(message: string, details?: Record<string, unknown>): AppError {
  return new AppError("UNSUPPORTED_EXPORT_FORMAT", message, { details, retryable: false });
}

/**
 * Marks an error raised before anything was written (opening and verifying the archive), so
 * reports can promise "nothing written" only then: a checksum mismatch found while storing an
 * original happens after earlier originals were already written.
 */
function beforeAnyWrite(error: unknown): unknown {
  if (!isAppError(error)) return error;
  return new AppError(error.code, error.message, {
    details: { ...error.details, nothingWritten: true },
    retryable: error.retryable,
    cause: error,
  });
}

/**
 * Postgres text and jsonb cannot store U+0000, so a NUL anywhere in the metadata would fail an
 * insert after the restore had started writing: it is refused at verification instead.
 * Iterative, so deeply nested JSON cannot overflow the stack.
 */
function holdsNul(root: unknown): boolean {
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      if (value.includes("\u0000")) return true;
    } else if (Array.isArray(value)) {
      pending.push(...value);
    } else if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (key.includes("\u0000")) return true;
        pending.push(item);
      }
    }
  }
  return false;
}

async function readJson<T>(zip: SafeZip, entryPath: string, schema: z.ZodType<T>): Promise<T> {
  if (!zip.has(entryPath)) throw invalidArchive(`${entryPath} is missing`);
  const raw = (await zip.readBuffer(entryPath, MAX_METADATA_BYTES)).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidArchive(`${entryPath} is not valid JSON`);
  }
  if (holdsNul(parsed)) throw invalidArchive(`${entryPath} contains a NUL character`);
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw invalidArchive(`${entryPath} does not match the export format`, {
      issues: result.error.issues.slice(0, 10).map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return result.data;
}

/** SHA-256 of one entry. Checks `signal` per chunk, so even one huge entry stops on abort. */
export async function hashEntry(
  zip: SafeZip,
  entryPath: string,
  signal?: AbortSignal,
): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of await zip.openStream(entryPath)) {
    signal?.throwIfAborted();
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

/** Strips the YAML front matter written by the exporter. */
function markdownBody(text: string): { title: string | null; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n\n?/.exec(text);
  if (!match) return { title: null, body: text };
  const titleLine = /^title: (.*)$/m.exec(match[1]!);
  let title: string | null = null;
  if (titleLine) {
    try {
      title = (JSON.parse(titleLine[1]!) as string) || null;
    } catch {
      title = null;
    }
  }
  return { title, body: text.slice(match[0].length).replace(/\n$/, "") };
}

/** Verifies the archive completely; returns its validated contents. Writes nothing. */
async function verifyArchive(zip: SafeZip, signal?: AbortSignal) {
  const header = await readJson(
    zip,
    PATHS.manifest,
    z.object({ format: z.string(), formatVersion: z.number() }).loose(),
  );
  if (header.format !== EXPORT_FORMAT || !SUPPORTED.includes(header.formatVersion)) {
    throw invalidArchive(
      `unsupported export format ${header.format} v${header.formatVersion} (this app reads v${SUPPORTED.join(", v")})`,
    );
  }
  const manifest: Manifest =
    header.formatVersion === 1
      ? await readJson(zip, PATHS.manifest, ManifestV1.loose())
      : header.formatVersion === 2
        ? await readJson(zip, PATHS.manifest, ManifestV2.loose())
        : header.formatVersion === 3
          ? await readJson(zip, PATHS.manifest, ManifestV3.loose())
          : await readJson(zip, PATHS.manifest, ManifestV4.loose());
  const schemaVersion = await readJson(zip, PATHS.schemaVersion, SchemaVersion.loose());
  if (schemaVersion.formatVersion !== manifest.formatVersion) {
    throw invalidArchive("schema-version.json and manifest.json disagree on the format version");
  }
  if (!zip.has(PATHS.checksums)) throw invalidArchive("checksums.sha256 is missing");
  const checksumsBytes = await zip.readBuffer(PATHS.checksums, MAX_METADATA_BYTES);
  if (createHash("sha256").update(checksumsBytes).digest("hex") !== manifest.checksumsSha256) {
    throw checksumMismatch("checksums.sha256 does not match the manifest", [PATHS.checksums]);
  }
  let listed: Map<string, string>;
  try {
    listed = parseChecksums(checksumsBytes.toString("utf8"));
  } catch (error) {
    if (error instanceof ChecksumFormatError) throw invalidArchive(error.message);
    throw error;
  }

  // The manifest is the root of trust: it pins checksums.sha256, so it cannot be listed there.
  const present = zip.inventory.entries
    .filter(
      (entry) =>
        !entry.isDirectory && entry.path !== PATHS.checksums && entry.path !== PATHS.manifest,
    )
    .map((entry) => entry.path);
  const unlisted = present.filter((entryPath) => !listed.has(entryPath));
  const missing = [...listed.keys()].filter((entryPath) => !zip.has(entryPath));
  if (unlisted.length > 0 || missing.length > 0) {
    throw checksumMismatch("the archive's files do not match checksums.sha256", [
      ...missing.map((entryPath) => `missing: ${entryPath}`),
      ...unlisted.map((entryPath) => `not listed: ${entryPath}`),
    ]);
  }
  const mismatched: string[] = [];
  for (const [entryPath, expected] of listed) {
    signal?.throwIfAborted();
    const actual = await hashEntry(zip, entryPath, signal);
    const addressed = hashFromOriginalPath(entryPath);
    if (actual !== expected || (addressed !== null && addressed !== actual)) {
      mismatched.push(entryPath);
    }
  }
  if (mismatched.length > 0) {
    throw checksumMismatch(
      `${mismatched.length} file(s) in the archive do not match their checksums`,
      mismatched,
    );
  }

  const projects = await readJson(zip, PATHS.projects, z.array(ProjectV1));
  const artifactList = await readJson(zip, PATHS.artifacts, z.array(ArtifactV1));
  const versions = await readJson(zip, PATHS.versions, z.array(VersionV1));
  const assets = await readJson(zip, PATHS.fileAssets, z.array(FileAssetV1));
  const links = await readJson(zip, PATHS.artifactFiles, z.array(ArtifactFileV1));
  // v1 archives have no tags.
  const tagList =
    manifest.formatVersion >= 2 ? await readJson(zip, PATHS.tags, z.array(TagV2)) : [];
  const tagLinks =
    manifest.formatVersion >= 2
      ? await readJson(zip, PATHS.artifactTags, z.array(ArtifactTagV2))
      : [];
  // v1 and v2 archives have no collections.
  const collectionList =
    manifest.formatVersion >= 3
      ? await readJson(zip, PATHS.collections, z.array(CollectionV3))
      : [];
  // v1–v3 archives have no notes or reading states.
  const noteList =
    manifest.formatVersion >= 4 ? await readJson(zip, PATHS.notes, z.array(NoteV4)) : [];
  const readingStateList =
    manifest.formatVersion >= 4
      ? await readJson(zip, PATHS.readingStates, z.array(ReadingStateV4))
      : [];
  const collectionLinks =
    manifest.formatVersion >= 3
      ? await readJson(zip, PATHS.collectionItems, z.array(CollectionItemV3))
      : [];

  // Primary ids must be unique: duplicates would silently collapse in the maps below, so a
  // version could be restored against the wrong original.
  const problems: string[] = [];
  const tables: [string, { id: string }[]][] = [
    ["project", projects],
    ["artifact", artifactList],
    ["version", versions],
    ["file asset", assets],
    ["artifact file", links],
    ["tag", tagList],
    ["collection", collectionList],
    ["note", noteList],
  ];
  for (const [kind, rows] of tables) {
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.id)) problems.push(`${kind} ${row.id}: duplicate id`);
      seen.add(row.id);
    }
  }

  // Referential integrity: every reference must resolve inside the archive.
  const projectIds = new Set(projects.map((project) => project.id));
  const artifactIds = new Set(artifactList.map((artifact) => artifact.id));
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const versionById = new Map(versions.map((version) => [version.id, version]));
  for (const asset of assets) {
    if (!listed.has(asset.archivePath) || hashFromOriginalPath(asset.archivePath) !== asset.sha256)
      problems.push(`file asset ${asset.id}: original not in archive`);
  }
  for (const artifact of artifactList) {
    if (artifact.projectId && !projectIds.has(artifact.projectId))
      problems.push(`artifact ${artifact.id}: unknown project`);
    if (
      artifact.currentVersionId &&
      versionById.get(artifact.currentVersionId)?.artifactId !== artifact.id
    )
      problems.push(`artifact ${artifact.id}: current version not among its versions`);
  }
  for (const version of versions) {
    if (!artifactIds.has(version.artifactId)) problems.push(`version ${version.id}: no artifact`);
    if (!assetById.has(version.primaryFileId))
      problems.push(`version ${version.id}: primary file missing`);
  }
  for (const link of links) {
    if (!versionById.has(link.artifactVersionId) || !assetById.has(link.fileAssetId))
      problems.push(`artifact file ${link.id}: dangling reference`);
  }
  // Tag names must be valid and distinct as the app compares them (restore merges by name).
  const tagIds = new Set(tagList.map((tag) => tag.id));
  const tagNames = new Set<string>();
  for (const tag of tagList) {
    try {
      const { normalizedName } = normalizeTagName(tag.name);
      if (tagNames.has(normalizedName)) problems.push(`tag ${tag.id}: duplicate name`);
      tagNames.add(normalizedName);
    } catch {
      problems.push(`tag ${tag.id}: invalid name`);
    }
  }
  const tagPairs = new Set<string>();
  for (const link of tagLinks) {
    if (!artifactIds.has(link.artifactId) || !tagIds.has(link.tagId))
      problems.push(`artifact tag ${link.artifactId}/${link.tagId}: dangling reference`);
    const pair = `${link.artifactId}/${link.tagId}`;
    if (tagPairs.has(pair)) problems.push(`artifact tag ${pair}: duplicate`);
    tagPairs.add(pair);
  }
  // Collections must form a tree no deeper than the app allows, with names valid and distinct
  // among siblings as the app compares them (restore merges by place and name).
  const collectionById = new Map(collectionList.map((collection) => [collection.id, collection]));
  const collectionLevel = new Map<string, number>();
  const siblingNames = new Set<string>();
  for (const collection of collectionList) {
    if (collection.parentId !== null && !collectionById.has(collection.parentId))
      problems.push(`collection ${collection.id}: unknown parent`);
    try {
      const { normalizedName } = normalizeCollectionName(collection.name);
      const key = `${collection.parentId ?? ""}/${normalizedName}`;
      if (siblingNames.has(key)) problems.push(`collection ${collection.id}: duplicate name`);
      siblingNames.add(key);
    } catch {
      problems.push(`collection ${collection.id}: invalid name`);
    }
    try {
      normalizeCollectionDescription(collection.description);
    } catch {
      problems.push(`collection ${collection.id}: invalid description`);
    }
    let level = 0;
    for (let at = collection.parentId; at !== null; at = collectionById.get(at)?.parentId ?? null) {
      level += 1;
      if (level > COLLECTION_MAX_DEPTH) {
        problems.push(`collection ${collection.id}: nested too deep, or in a cycle`);
        break;
      }
    }
    collectionLevel.set(collection.id, level);
  }
  const notesPerArtifact = new Map<string, number>();
  for (const note of noteList) {
    if (!artifactIds.has(note.artifactId)) problems.push(`note ${note.id}: no artifact`);
    // The app's own limits, Markdown complexity included: a restored note is shown and
    // indexed like a written one.
    try {
      normalizeNoteBody(note.bodyMarkdown);
    } catch {
      problems.push(`note ${note.id}: invalid text`);
    }
    const count = (notesPerArtifact.get(note.artifactId) ?? 0) + 1;
    notesPerArtifact.set(note.artifactId, count);
    if (count === NOTES_PER_ARTIFACT_MAX + 1)
      problems.push(`artifact ${note.artifactId}: more than ${NOTES_PER_ARTIFACT_MAX} notes`);
  }
  const stateArtifacts = new Set<string>();
  for (const state of readingStateList) {
    if (!artifactIds.has(state.artifactId))
      problems.push(`reading state ${state.artifactId}: no artifact`);
    if (stateArtifacts.has(state.artifactId))
      problems.push(`reading state ${state.artifactId}: duplicate`);
    stateArtifacts.add(state.artifactId);
  }
  const collectionPairs = new Set<string>();
  for (const item of collectionLinks) {
    if (!artifactIds.has(item.artifactId) || !collectionById.has(item.collectionId))
      problems.push(`collection item ${item.collectionId}/${item.artifactId}: dangling reference`);
    const pair = `${item.collectionId}/${item.artifactId}`;
    if (collectionPairs.has(pair)) problems.push(`collection item ${pair}: duplicate`);
    collectionPairs.add(pair);
  }
  if (problems.length > 0) {
    throw invalidArchive("the archive's metadata is inconsistent", {
      problems: problems.slice(0, MAX_LISTED_PROBLEMS),
    });
  }
  return {
    manifest,
    verified: listed.size,
    projects,
    artifactList,
    versions,
    assets,
    links,
    tagList,
    tagLinks,
    /** Parents before children. */
    collectionList: collectionList
      .map((collection, index) => ({ collection, index }))
      .sort(
        (a, b) =>
          collectionLevel.get(a.collection.id)! - collectionLevel.get(b.collection.id)! ||
          a.index - b.index,
      )
      .map(({ collection }) => collection),
    collectionLinks,
    noteList,
    readingStateList,
  };
}

/** Postgres caps bind parameters at 65,535; id lookups are done in chunks well below that. */
const ID_CHUNK = 10_000;
/** Note rows per insert statement (7 parameters each). */
const NOTE_INSERT_BATCH = 500;

async function inChunks<T>(ids: string[], query: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const rows: T[] = [];
  for (let start = 0; start < ids.length; start += ID_CHUNK) {
    rows.push(...(await query(ids.slice(start, start + ID_CHUNK))));
  }
  return rows;
}

/** id → owning workspace (null for tables without a workspace column), for ids that exist. */
async function existingIds(
  db: DbExecutor,
  table:
    | typeof artifacts
    | typeof researchProjects
    | typeof artifactVersions
    | typeof artifactFiles
    | typeof tags
    | typeof collections
    | typeof artifactNotes,
  ids: string[],
): Promise<Map<string, string | null>> {
  const rows = await inChunks(ids, async (chunk) =>
    table === artifactFiles
      ? (
          await db
            .select({ id: artifactFiles.id })
            .from(artifactFiles)
            .where(inArray(artifactFiles.id, chunk))
        ).map((row) => ({ id: row.id, workspaceId: null as string | null }))
      : await db
          .select({ id: table.id, workspaceId: (table as typeof artifacts).workspaceId })
          .from(table as typeof artifacts)
          .where(inArray(table.id, chunk)),
  );
  return new Map(rows.map((row) => [row.id, row.workspaceId]));
}

export async function restoreArchive(
  db: Database,
  storage: StorageAdapter,
  input: {
    archivePath: string;
    workspaceId: string;
    userId: string | null;
    mode: RestoreMode;
    restoreId: string;
    limits: RestoreLimits;
    signal?: AbortSignal;
  },
): Promise<RestoreReport> {
  const { signal } = input;
  const startedAt = Date.now();
  let zip: SafeZip;
  try {
    zip = await SafeZip.open(input.archivePath, input.limits);
  } catch (error) {
    if (error instanceof ZipRejectedError)
      throw beforeAnyWrite(invalidArchive(`not a safe ZIP: ${error.message}`));
    throw error;
  }
  const tmp = await mkdtemp(path.join(tmpdir(), "vault-restore-"));
  try {
    const archive = await verifyArchive(zip, signal).catch((error: unknown) => {
      throw beforeAnyWrite(error);
    });
    const { workspaceId, mode } = input;
    const report: RestoreReport = {
      source: {
        formatVersion: archive.manifest.formatVersion,
        appVersion: archive.manifest.appVersion,
        dbMigration: archive.manifest.dbMigration,
        createdAt: archive.manifest.createdAt,
        workspace: archive.manifest.workspace,
      },
      checksums: { verified: archive.verified },
      counts: {
        researchProjects: tally(),
        artifacts: tally(),
        artifactVersions: tally(),
        fileAssets: { stored: 0, reused: 0, repaired: 0 },
        tags: tally(),
        artifactTags: 0,
        artifactTagsKept: 0,
        artifactTagsDropped: 0,
        collections: tally(),
        collectionItems: 0,
        collectionItemsKept: 0,
        collectionItemsDropped: 0,
        notes: tally(),
        readingStates: 0,
      },
      idMap: {},
      failures: [],
      warnings: [],
      reextractJobs: 0,
      durationMs: 0,
    };
    const remember = (oldId: string, newIdValue: string) => {
      if (oldId !== newIdValue && Object.keys(report.idMap).length < 10_000)
        report.idMap[oldId] = newIdValue;
    };

    /** Deterministic per-target-workspace id for an archived id that belongs to someone else. */
    const derivedId = (oldId: string) => deterministicId(`restore:${workspaceId}:${oldId}`);
    /** Copy-mode id: derived from this run, so a retried attempt finds what it already copied. */
    const copyId = (oldId: string) => deterministicId(`restore-copy:${input.restoreId}:${oldId}`);
    /**
     * Second, still deterministic choice for when the derived/copy id already belongs to another
     * workspace (e.g. a restored export of an earlier restore): a retry finds it again, which a
     * random id would not. Both taken by others is refused rather than guessed.
     */
    const fallbackId = (oldId: string) =>
      deterministicId(
        mode === "copy"
          ? `restore-copy:${input.restoreId}:${oldId}:fallback`
          : `restore:${workspaceId}:${oldId}:fallback`,
      );
    const fallback = (oldId: string, owners: Map<string, string | null>) => {
      const id = fallbackId(oldId);
      const owner = owners.get(id);
      if (owner === undefined) return { id, existing: false, remapped: true, resumed: false };
      if (owner === workspaceId)
        return { id, existing: true, remapped: true, resumed: mode === "copy" };
      throw new AppError("CONFLICT", `restore ids for ${oldId} are taken by other workspaces`, {
        retryable: false,
      });
    };
    /**
     * Where an archived row goes. skip_existing: its own id when free or already ours, else a
     * derived id (so re-running the same restore finds it instead of duplicating it).
     * copy: always its copy id; `resumed` when an earlier attempt of this run inserted it.
     */
    const place = (oldId: string, owners: Map<string, string | null>) => {
      if (mode === "copy") {
        const id = copyId(oldId);
        const owner = owners.get(id);
        if (owner === undefined) return { id, existing: false, remapped: true, resumed: false };
        if (owner === workspaceId) return { id, existing: true, remapped: true, resumed: true };
        return fallback(oldId, owners);
      }
      const owner = owners.get(oldId);
      if (owner === undefined)
        return { id: oldId, existing: false, remapped: false, resumed: false };
      if (owner === workspaceId)
        return { id: oldId, existing: true, remapped: false, resumed: false };
      const derived = derivedId(oldId);
      const derivedOwner = owners.get(derived);
      if (derivedOwner === undefined)
        return { id: derived, existing: false, remapped: true, resumed: false };
      if (derivedOwner === workspaceId)
        return { id: derived, existing: true, remapped: true, resumed: false };
      return fallback(oldId, owners);
    };
    const withDerived = (ids: string[]) => [
      ...ids,
      ...ids.map(mode === "copy" ? copyId : derivedId),
      ...ids.map(fallbackId),
    ];

    // ---- 1. Originals (content-addressed; the target workspace dedups by hash) ----
    // Every original is re-verified and written idempotently, also when its row already exists:
    // that repairs objects lost from storage while the database survived.
    const assetIdMap = new Map<string, string>();
    const takenAssetIds = new Set(
      (
        await inChunks(
          archive.assets.map((asset) => asset.id),
          (chunk) =>
            db.select({ id: fileAssets.id }).from(fileAssets).where(inArray(fileAssets.id, chunk)),
        )
      ).map((row) => row.id),
    );
    for (const asset of archive.assets) {
      signal?.throwIfAborted();
      const file = path.join(tmp, asset.sha256);
      const hash = createHash("sha256");
      await pipeline(
        await zip.openStream(asset.archivePath),
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            hash.update(chunk);
            callback(null, chunk);
          },
        }),
        createWriteStream(file, { flags: "w", mode: 0o600 }),
        { signal },
      );
      if (hash.digest("hex") !== asset.sha256)
        throw checksumMismatch("an original changed while restoring", [asset.archivePath]);
      const { storageKey, created } = await storeOriginal(storage, {
        signal,
        workspaceId,
        sha256: asset.sha256,
        size: asset.byteSize,
        mimeType: asset.mimeType,
        sourcePath: file,
      });
      await rm(file, { force: true });

      const [existing] = await db
        .select({ id: fileAssets.id })
        .from(fileAssets)
        .where(and(eq(fileAssets.workspaceId, workspaceId), eq(fileAssets.sha256, asset.sha256)));
      if (existing) {
        assetIdMap.set(asset.id, existing.id);
        remember(asset.id, existing.id);
        report.counts.fileAssets.reused += 1;
        if (created) report.counts.fileAssets.repaired += 1;
        continue;
      }
      const id = takenAssetIds.has(asset.id) ? newId() : asset.id;
      const [inserted] = await db
        .insert(fileAssets)
        .values({
          id,
          workspaceId,
          storageProvider: storage.provider,
          storageKey,
          originalFilename: asset.originalFilename,
          mimeType: asset.mimeType,
          byteSize: asset.byteSize,
          sha256: asset.sha256,
          storageStatus: "stored",
          integrityVerifiedAt: new Date(),
          createdBy: input.userId,
          createdAt: new Date(asset.createdAt),
        })
        .onConflictDoNothing({ target: [fileAssets.workspaceId, fileAssets.sha256] })
        .returning({ id: fileAssets.id });
      const finalId =
        inserted?.id ??
        (
          await db
            .select({ id: fileAssets.id })
            .from(fileAssets)
            .where(
              and(eq(fileAssets.workspaceId, workspaceId), eq(fileAssets.sha256, asset.sha256)),
            )
        )[0]!.id;
      assetIdMap.set(asset.id, finalId);
      remember(asset.id, finalId);
      report.counts.fileAssets.stored += 1;
    }

    // ---- 2. Research projects ----
    const projectIdMap = new Map<string, string>();
    const projectOwners = await existingIds(
      db,
      researchProjects,
      withDerived(archive.projects.map((project) => project.id)),
    );
    for (const project of archive.projects) {
      signal?.throwIfAborted();
      const placed = place(project.id, projectOwners);
      projectIdMap.set(project.id, placed.id);
      if (placed.existing) {
        report.counts.researchProjects[placed.resumed ? "copied" : "skipped"] += 1;
        if (placed.resumed) remember(project.id, placed.id);
        continue;
      }
      const ownedHere = projectOwners.get(project.id) === workspaceId;
      await db.insert(researchProjects).values({
        id: placed.id,
        workspaceId,
        title: ownedHere ? `${project.title}${COPY_SUFFIX}` : project.title,
        description: project.description,
        status: project.status,
        createdBy: input.userId,
        createdAt: new Date(project.createdAt),
        updatedAt: new Date(project.updatedAt),
        deletedAt: project.deletedAt ? new Date(project.deletedAt) : null,
      });
      remember(project.id, placed.id);
      report.counts.researchProjects[placed.remapped ? "copied" : "restored"] += 1;
    }

    // ---- 2b. Tags (v2): merged by name, so a restore never duplicates a tag ----
    // The same tag (same id, already ours, perhaps renamed since the export) and a copy resumed
    // from an earlier attempt map to themselves. Otherwise the tag is inserted under its placed
    // id, and a name the target workspace already has maps to that tag instead (the unique
    // name constraint decides, so a concurrent restore cannot duplicate it either).
    const tagIdMap = new Map<string, string>();
    const tagOwners = await existingIds(
      db,
      tags,
      withDerived(archive.tagList.map((tag) => tag.id)),
    );
    for (const tag of archive.tagList) {
      signal?.throwIfAborted();
      const { name, normalizedName } = normalizeTagName(tag.name);
      const byName = async () =>
        (
          await db
            .select({ id: tags.id })
            .from(tags)
            .where(and(eq(tags.workspaceId, workspaceId), eq(tags.normalizedName, normalizedName)))
        )[0];
      const placed = place(tag.id, tagOwners);
      if (placed.existing) {
        tagIdMap.set(tag.id, placed.id);
        remember(tag.id, placed.id);
        report.counts.tags[placed.resumed ? "copied" : "skipped"] += 1;
        continue;
      }
      let finalId: string | undefined;
      let inserted = false;
      // The same-name tag can be renamed or deleted between the insert and the lookup: try
      // again a few times, then fail clearly rather than guess.
      for (let attempt = 0; attempt < 3 && !finalId; attempt += 1) {
        const [row] = await db
          .insert(tags)
          .values({
            id: placed.id,
            workspaceId,
            name,
            normalizedName,
            createdAt: new Date(tag.createdAt),
            updatedAt: new Date(tag.updatedAt),
          })
          .onConflictDoNothing({ target: [tags.workspaceId, tags.normalizedName] })
          .returning({ id: tags.id });
        inserted = row !== undefined;
        finalId = row?.id ?? (await byName())?.id;
      }
      if (!finalId) {
        throw new AppError("CONFLICT", `tag ${tag.id} changed while it was being restored`, {
          retryable: true,
        });
      }
      tagIdMap.set(tag.id, finalId);
      remember(tag.id, finalId);
      report.counts.tags[inserted ? (placed.remapped ? "copied" : "restored") : "skipped"] += 1;
    }
    const tagLinksByArtifact = new Map<string, typeof archive.tagLinks>();
    for (const link of archive.tagLinks) {
      const list = tagLinksByArtifact.get(link.artifactId) ?? [];
      list.push(link);
      tagLinksByArtifact.set(link.artifactId, list);
    }
    /**
     * The target tags an archived artifact's links map to, with the first link's date. Two
     * archived tags can map to one tag here (merged by name, or the same tag renamed since an
     * older export), so this is de-duplicated.
     */
    const mappedLinks = (archivedArtifactId: string) => {
      const links = new Map<string, Date>();
      for (const link of tagLinksByArtifact.get(archivedArtifactId) ?? []) {
        const tagId = tagIdMap.get(link.tagId)!;
        if (!links.has(tagId)) links.set(tagId, new Date(link.createdAt));
      }
      return links;
    };

    // ---- 2c. Collections (v3): merged by place and name, parents first ----
    // As with tags, a restore never duplicates a collection. One with the same id that is
    // already ours (perhaps renamed or moved since the export) and a copy resumed from an
    // earlier attempt map to themselves; otherwise the collection is inserted under its
    // restored parent, and a sibling of the same name there maps to that one instead. Each
    // insert takes the workspace's tree lock and re-checks its parent and depth, like creating a
    // collection in the app. One that cannot be placed (its parent was deleted meanwhile, or
    // merging into this tree would nest it too deep) is not restored, nor is anything below it.
    const collectionIdMap = new Map<string, string>();
    const collectionOwners = await existingIds(
      db,
      collections,
      withDerived(archive.collectionList.map((collection) => collection.id)),
    );
    for (const collection of archive.collectionList) {
      signal?.throwIfAborted();
      const placed = place(collection.id, collectionOwners);
      if (placed.existing) {
        collectionIdMap.set(collection.id, placed.id);
        remember(collection.id, placed.id);
        report.counts.collections[placed.resumed ? "copied" : "skipped"] += 1;
        continue;
      }
      // Parents come first, so a parent that is not mapped could not be placed.
      const parentId =
        collection.parentId === null ? null : collectionIdMap.get(collection.parentId);
      const { name, normalizedName } = normalizeCollectionName(collection.name);
      const result =
        parentId === undefined
          ? null
          : await db.transaction(async (tx) => {
              await lockCollectionTree(tx, workspaceId);
              if (parentId !== null) {
                const [parent] = await tx
                  .select({ id: collections.id })
                  .from(collections)
                  .where(
                    and(eq(collections.id, parentId), eq(collections.workspaceId, workspaceId)),
                  );
                if (!parent) return null;
                if ((await collectionDepth(tx, parentId)) + 1 > COLLECTION_MAX_DEPTH) return null;
              }
              const [row] = await tx
                .insert(collections)
                .values({
                  id: placed.id,
                  workspaceId,
                  parentId,
                  kind: collection.kind,
                  name,
                  normalizedName,
                  description: normalizeCollectionDescription(collection.description),
                  sortOrder: collection.sortOrder,
                  createdAt: new Date(collection.createdAt),
                  updatedAt: new Date(collection.updatedAt),
                })
                .onConflictDoNothing({
                  target: [
                    collections.workspaceId,
                    collections.parentId,
                    collections.normalizedName,
                  ],
                })
                .returning({ id: collections.id });
              if (row) return { id: row.id, inserted: true };
              // The tree lock keeps the sibling from being moved or deleted, but not renamed:
              // if it was renamed since the insert, this collection is not placed.
              const [sibling] = await tx
                .select({ id: collections.id })
                .from(collections)
                .where(
                  and(
                    eq(collections.workspaceId, workspaceId),
                    parentId === null
                      ? isNull(collections.parentId)
                      : eq(collections.parentId, parentId),
                    eq(collections.normalizedName, normalizedName),
                  ),
                );
              return sibling ? { id: sibling.id, inserted: false } : null;
            });
      if (!result) {
        report.counts.collections.failed += 1;
        continue;
      }
      collectionIdMap.set(collection.id, result.id);
      remember(collection.id, result.id);
      report.counts.collections[
        result.inserted ? (placed.remapped ? "copied" : "restored") : "skipped"
      ] += 1;
    }
    const collectionItemsByArtifact = new Map<string, typeof archive.collectionLinks>();
    for (const item of archive.collectionLinks) {
      const list = collectionItemsByArtifact.get(item.artifactId) ?? [];
      list.push(item);
      collectionItemsByArtifact.set(item.artifactId, list);
    }
    /**
     * The target collections an archived artifact's items map to (two can map to one, merged
     * by name), and how many items have no target because their collection was not placed.
     */
    const mappedItems = (archivedArtifactId: string) => {
      const items = new Map<string, { position: number; addedAt: Date }>();
      let unplaced = 0;
      for (const item of collectionItemsByArtifact.get(archivedArtifactId) ?? []) {
        const collectionId = collectionIdMap.get(item.collectionId);
        if (!collectionId) unplaced += 1;
        else if (!items.has(collectionId))
          items.set(collectionId, { position: item.position, addedAt: new Date(item.addedAt) });
      }
      return { items, unplaced };
    };

    // ---- 3. Artifacts and versions, one transaction per artifact ----
    const versionsByArtifact = new Map<string, typeof archive.versions>();
    for (const version of archive.versions) {
      const list = versionsByArtifact.get(version.artifactId) ?? [];
      list.push(version);
      versionsByArtifact.set(version.artifactId, list);
    }
    const linksByVersion = new Map<string, typeof archive.links>();
    for (const link of archive.links) {
      const list = linksByVersion.get(link.artifactVersionId) ?? [];
      list.push(link);
      linksByVersion.set(link.artifactVersionId, list);
    }
    const artifactOwners = await existingIds(
      db,
      artifacts,
      withDerived(archive.artifactList.map((artifact) => artifact.id)),
    );
    const versionOwners = await existingIds(
      db,
      artifactVersions,
      withDerived(archive.versions.map((version) => version.id)),
    );
    const takenLinkIds = await existingIds(
      db,
      artifactFiles,
      withDerived(archive.links.map((link) => link.id)),
    );
    const linkId = (oldId: string) =>
      !takenLinkIds.has(oldId)
        ? oldId
        : !takenLinkIds.has(derivedId(oldId))
          ? derivedId(oldId)
          : newId();

    /** Inserts one version with its files, fallback text and re-extraction job. */
    const insertVersion = async (
      tx: DbExecutor,
      version: (typeof archive.versions)[number],
      versionId: string,
      artifactId: string,
    ) => {
      await tx.insert(artifactVersions).values({
        id: versionId,
        workspaceId,
        artifactId,
        versionNumber: version.versionNumber,
        primaryFileId: assetIdMap.get(version.primaryFileId)!,
        contentKind: version.contentKind,
        previewKind: version.previewKind,
        previewStatus: "pending",
        previewEntryPath: version.previewEntryPath,
        processingStatus: "pending",
        contentHash: version.contentHash,
        sourcePlatform: version.sourcePlatform,
        sourceModel: version.sourceModel,
        originalPrompt: version.originalPrompt,
        sourceUrl: version.sourceUrl,
        researchDate: version.researchDate,
        author: version.author,
        referenceSources: version.referenceSources.map((reference) =>
          reference.title ? { title: reference.title, url: reference.url } : { url: reference.url },
        ),
        changeSummary: version.changeSummary,
        analysis: version.analysis,
        createdBy: input.userId,
        createdAt: new Date(version.createdAt),
        updatedAt: new Date(version.updatedAt),
      });
      for (const link of linksByVersion.get(version.id) ?? []) {
        await tx.insert(artifactFiles).values({
          id: mode === "copy" ? copyId(link.id) : linkId(link.id),
          artifactVersionId: versionId,
          fileAssetId: assetIdMap.get(link.fileAssetId)!,
          role: link.role,
          displayName: link.displayName,
          createdAt: new Date(link.createdAt),
        });
      }
      // Fallback text right away; re-extraction replaces it with a full extraction.
      const normalized = normalizedPath(version.id);
      if (zip.has(normalized)) {
        const { title, body } = markdownBody(
          (await zip.readBuffer(normalized, MAX_METADATA_BYTES)).toString("utf8"),
        );
        await saveExtraction(tx, {
          workspaceId,
          versionId,
          extraction: {
            method: RESTORE_EXTRACTION_METHOD,
            version: EXPORT_FORMAT_VERSION,
            status: "partial",
            title,
            language: null,
            plainText: body,
            markdown: body,
            sections: [],
            metadata: {},
            references: [],
            warnings: ["RESTORED_FROM_ARCHIVE: archived text pending re-extraction"],
          },
        });
      } else {
        // No archived text (an image, say): index the metadata now, so the artifact is found
        // by title even if re-extraction fails for good.
        await enqueueVersionIndex(tx, { workspaceId, versionId, extractionId: null });
      }
      await enqueueJob(tx, {
        type: REEXTRACT_JOB_TYPE,
        idempotencyKey: `${REEXTRACT_JOB_TYPE}:${versionId}`,
        workspaceId,
        payload: { versionId },
      });
      if (versionId !== version.id) remember(version.id, versionId);
    };

    /**
     * A new artifact's collection items, in its transaction. The target collections are locked
     * in id order (key share: they cannot be deleted until this commits); a collection that was
     * not placed or was deleted since is dropped and counted instead of failing the artifact.
     */
    const restoreItems = async (tx: DbExecutor, archivedId: string, artifactId: string) => {
      const { items, unplaced } = mappedItems(archivedId);
      if (items.size === 0) return { written: 0, dropped: unplaced, notes: tally(), states: 0 };
      const live = new Set(
        (
          await tx
            .select({ id: collections.id })
            .from(collections)
            .where(
              and(
                eq(collections.workspaceId, workspaceId),
                inArray(collections.id, [...items.keys()]),
              ),
            )
            .orderBy(asc(collections.id))
            .for("key share")
        ).map((row) => row.id),
      );
      const rows = [...items]
        .filter(([collectionId]) => live.has(collectionId))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([collectionId, item]) => ({
          workspaceId,
          collectionId,
          artifactId,
          position: item.position,
          addedAt: item.addedAt,
        }));
      const written =
        rows.length > 0
          ? await tx
              .insert(collectionItems)
              .values(rows)
              .onConflictDoNothing()
              .returning({ collectionId: collectionItems.collectionId })
          : [];
      return {
        written: written.length,
        dropped: unplaced + items.size - rows.length,
        notes: tally(),
        states: 0,
      };
    };

    // Notes and reading states (v4), by archived artifact.
    const notesByArtifact = new Map<string, typeof archive.noteList>();
    for (const note of archive.noteList) {
      const list = notesByArtifact.get(note.artifactId) ?? [];
      list.push(note);
      notesByArtifact.set(note.artifactId, list);
    }
    const readingStateByArtifact = new Map(
      archive.readingStateList.map((state) => [state.artifactId, state]),
    );
    const noteOwners = await existingIds(
      db,
      artifactNotes,
      withDerived(archive.noteList.map((note) => note.id)),
    );
    /**
     * Inserts notes on `artifactId` under their placed ids, a few hundred rows per statement
     * (Postgres takes at most 65,535 parameters). Counts each written note as restored or
     * copied, and one whose id already exists as skipped.
     */
    const insertNotes = async (
      tx: DbExecutor,
      notes: typeof archive.noteList,
      artifactId: string,
    ) => {
      const placed = notes.map((note) => ({ note, at: place(note.id, noteOwners) }));
      const written = new Set<string>();
      for (let start = 0; start < placed.length; start += NOTE_INSERT_BATCH) {
        const rows = await tx
          .insert(artifactNotes)
          .values(
            placed.slice(start, start + NOTE_INSERT_BATCH).map(({ note, at }) => ({
              id: at.id,
              workspaceId,
              artifactId,
              authorId: input.userId,
              bodyMarkdown: normalizeNoteBody(note.bodyMarkdown),
              createdAt: new Date(note.createdAt),
              updatedAt: new Date(note.updatedAt),
            })),
          )
          .onConflictDoNothing()
          .returning({ id: artifactNotes.id });
        for (const row of rows) written.add(row.id);
      }
      const counts = tally();
      for (const { note, at } of placed) {
        if (!written.has(at.id)) {
          counts.skipped += 1;
          continue;
        }
        counts[at.remapped ? "copied" : "restored"] += 1;
        remember(note.id, at.id);
      }
      return counts;
    };
    const addNoteCounts = (counts: Tally) => {
      for (const outcome of Object.keys(counts) as Outcome[]) {
        report.counts.notes[outcome] += counts[outcome];
      }
    };
    /**
     * An artifact that already exists gets the archived notes it lacks, as it gets the versions
     * it lacks: notes are content, and a restore is how lost ones come back. The artifact is
     * locked first and re-indexed, as every note write does.
     */
    const restoreLackedNotes = async (
      artifact: (typeof archive.artifactList)[number],
      artifactId: string,
    ) => {
      const placedNotes = (notesByArtifact.get(artifact.id) ?? []).map((note) => ({
        note,
        at: place(note.id, noteOwners),
      }));
      for (const { note, at } of placedNotes) {
        if (!at.existing) continue;
        // A copy resumed from an earlier attempt of this run counts as copied, as it was then.
        report.counts.notes[at.resumed ? "copied" : "skipped"] += 1;
        if (at.resumed) remember(note.id, at.id);
      }
      const lacked = placedNotes.filter(({ at }) => !at.existing);
      if (lacked.length === 0) return;
      try {
        addNoteCounts(
          await db.transaction(async (tx) => {
            await tx
              .select({ id: artifacts.id })
              .from(artifacts)
              .where(eq(artifacts.id, artifactId))
              .for("update");
            const counts = await insertNotes(
              tx,
              lacked.map(({ note }) => note),
              artifactId,
            );
            await indexArtifactMetadata(tx, artifactId);
            return counts;
          }),
        );
      } catch (error) {
        // The artifact itself is fine (it already existed): a warning, not a failure.
        report.counts.notes.failed += lacked.length;
        report.warnings.push(
          `${lacked.length} note(s) of artifact ${artifactId} were not restored: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`,
        );
      }
    };

    const fail = (artifact: (typeof archive.artifactList)[number], error: unknown) => {
      report.failures.push({
        artifactId: artifact.id,
        title: artifact.title.slice(0, 200),
        error: error instanceof Error ? error.message.slice(0, 500) : String(error),
      });
    };

    for (const artifact of archive.artifactList) {
      signal?.throwIfAborted();
      const versions = versionsByArtifact.get(artifact.id) ?? [];
      const placed = place(artifact.id, artifactOwners);
      const ownedHere = artifactOwners.get(artifact.id) === workspaceId;
      if (placed.remapped && !ownedHere && artifactOwners.has(artifact.id)) {
        report.warnings.push(
          `artifact ${artifact.id} exists in another workspace; restored as ${placed.id}`,
        );
      }

      if (placed.existing) {
        const links = mappedLinks(artifact.id);
        if (links.size > 0) {
          const present = new Set(
            (
              await db
                .select({ tagId: artifactTags.tagId })
                .from(artifactTags)
                .where(
                  and(
                    eq(artifactTags.artifactId, placed.id),
                    inArray(artifactTags.tagId, [...links.keys()]),
                  ),
                )
            ).map((row) => row.tagId),
          );
          // A copy resumed from an earlier attempt wrote its links then: count them as now.
          if (placed.resumed) report.counts.artifactTags += present.size;
          else report.counts.artifactTagsKept += links.size - present.size;
        }
        const { items, unplaced } = mappedItems(artifact.id);
        report.counts.collectionItemsDropped += unplaced;
        if (items.size > 0) {
          const present = new Set(
            (
              await db
                .select({ collectionId: collectionItems.collectionId })
                .from(collectionItems)
                .where(
                  and(
                    eq(collectionItems.artifactId, placed.id),
                    inArray(collectionItems.collectionId, [...items.keys()]),
                  ),
                )
            ).map((row) => row.collectionId),
          );
          if (placed.resumed) report.counts.collectionItems += present.size;
          else report.counts.collectionItemsKept += items.size - present.size;
        }
        await restoreLackedNotes(artifact, placed.id);
        // skip_existing keeps the artifact as it is, but versions it lacks (e.g. newer ones in
        // the archive than in a database restored to an earlier point) are added to it. A copy
        // resumed from an earlier attempt of this run counts as copied, as it was then.
        const bucket = placed.resumed ? "copied" : "skipped";
        report.counts.artifacts[bucket] += 1;
        if (placed.resumed) {
          remember(artifact.id, placed.id);
          for (const version of versions) remember(version.id, place(version.id, versionOwners).id);
        }
        const missing = versions
          .map((version) => ({ version, at: place(version.id, versionOwners) }))
          .filter(({ at }) => !at.existing);
        report.counts.artifactVersions[bucket] += versions.length - missing.length;
        if (missing.length === 0) continue;
        try {
          const added = await db.transaction(async (tx) => {
            await tx
              .select({ id: artifacts.id })
              .from(artifacts)
              .where(eq(artifacts.id, placed.id))
              .for("update");
            const taken = new Set(
              (
                await tx
                  .select({ number: artifactVersions.versionNumber })
                  .from(artifactVersions)
                  .where(eq(artifactVersions.artifactId, placed.id))
              ).map((row) => row.number),
            );
            let count = 0;
            for (const { version, at } of missing) {
              if (taken.has(version.versionNumber)) {
                report.counts.artifactVersions.failed += 1;
                report.warnings.push(
                  `version ${version.id}: artifact ${placed.id} already has a different version ${version.versionNumber}; not restored`,
                );
                continue;
              }
              await insertVersion(tx, version, at.id, placed.id);
              count += 1;
              // The archive's current version came back: point the artifact at it, unless the
              // target already moved on to a newer version.
              if (version.id === artifact.currentVersionId) {
                const [current] = await tx
                  .select({ number: artifactVersions.versionNumber })
                  .from(artifacts)
                  .leftJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
                  .where(eq(artifacts.id, placed.id));
                if (current?.number == null || current.number < version.versionNumber) {
                  await tx
                    .update(artifacts)
                    .set({ currentVersionId: at.id })
                    .where(eq(artifacts.id, placed.id));
                }
              }
            }
            return count;
          });
          report.reextractJobs += added;
          report.counts.artifactVersions.restored += added;
        } catch (error) {
          report.counts.artifactVersions.failed += missing.length;
          fail(artifact, error);
        }
        continue;
      }

      try {
        // A version of this new artifact that is here already belongs to another artifact: the
        // archive was made after it was split off into this one, and this database predates the
        // split. skip_existing keeps that artifact as it is, so this one cannot come back here.
        const taken = versions.find((version) => place(version.id, versionOwners).existing);
        if (taken) {
          throw new AppError(
            "CONFLICT",
            `version ${taken.id} already belongs to another artifact here (it was split off into this one after this database was saved); restore in copy mode to bring this artifact back as a copy`,
            { retryable: false },
          );
        }
        const linkedTags = await db.transaction(async (tx) => {
          await tx.insert(artifacts).values({
            id: placed.id,
            workspaceId,
            projectId: artifact.projectId ? (projectIdMap.get(artifact.projectId) ?? null) : null,
            title: ownedHere ? `${artifact.title}${COPY_SUFFIX}` : artifact.title,
            description: artifact.description,
            summary: artifact.summary,
            visibility: artifact.visibility,
            sensitivity: artifact.sensitivity,
            reviewStatus: artifact.reviewStatus,
            identityKey: artifact.identityKey,
            originRef: placed.remapped
              ? `restore:${input.restoreId}:${artifact.id}`
              : artifact.originRef,
            metadata: artifact.metadata,
            createdBy: input.userId,
            createdAt: new Date(artifact.createdAt),
            updatedAt: new Date(artifact.updatedAt),
            deletedAt: artifact.deletedAt ? new Date(artifact.deletedAt) : null,
          });
          const versionIdMap = new Map<string, string>();
          for (const version of versions) {
            const versionId = place(version.id, versionOwners).id;
            versionIdMap.set(version.id, versionId);
            await insertVersion(tx, version, versionId, placed.id);
          }
          if (artifact.currentVersionId) {
            await tx
              .update(artifacts)
              .set({ currentVersionId: versionIdMap.get(artifact.currentVersionId)! })
              .where(eq(artifacts.id, placed.id));
          }
          // Tags come back with the artifact, in its transaction (an artifact that already
          // exists keeps its own tags, above). The target tags are locked in id order first,
          // as every tag operation locks them, so this cannot deadlock with a merge; a tag
          // deleted or merged since the tag phase is gone, and its link is dropped and counted
          // instead of failing the artifact.
          const collected = await restoreItems(tx, artifact.id, placed.id);
          const noted = await insertNotes(tx, notesByArtifact.get(artifact.id) ?? [], placed.id);
          const state = readingStateByArtifact.get(artifact.id);
          if (state && input.userId) {
            const written = await tx
              .insert(artifactReadingStates)
              .values({
                userId: input.userId,
                workspaceId,
                artifactId: placed.id,
                status: state.status,
                isFavorite: state.isFavorite,
                lastOpenedAt: state.lastOpenedAt ? new Date(state.lastOpenedAt) : null,
              })
              .onConflictDoNothing()
              .returning({ artifactId: artifactReadingStates.artifactId });
            collected.states = written.length;
          }
          collected.notes = noted;
          const links = mappedLinks(artifact.id);
          if (links.size === 0) return { written: 0, dropped: 0, collected };
          const live = new Set(
            (
              await tx
                .select({ id: tags.id })
                .from(tags)
                .where(and(eq(tags.workspaceId, workspaceId), inArray(tags.id, [...links.keys()])))
                .orderBy(asc(tags.id))
                .for("key share")
            ).map((row) => row.id),
          );
          const rows = [...links]
            .filter(([tagId]) => live.has(tagId))
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([tagId, createdAt]) => ({
              workspaceId,
              artifactId: placed.id,
              tagId,
              createdAt,
            }));
          const written =
            rows.length > 0
              ? await tx
                  .insert(artifactTags)
                  .values(rows)
                  .onConflictDoNothing()
                  .returning({ tagId: artifactTags.tagId })
              : [];
          return { written: written.length, dropped: links.size - rows.length, collected };
        });
        report.reextractJobs += versions.length;
        report.counts.artifactTags += linkedTags.written;
        report.counts.artifactTagsDropped += linkedTags.dropped;
        report.counts.collectionItems += linkedTags.collected.written;
        report.counts.collectionItemsDropped += linkedTags.collected.dropped;
        addNoteCounts(linkedTags.collected.notes);
        report.counts.readingStates += linkedTags.collected.states;
        report.counts.artifacts[placed.remapped ? "copied" : "restored"] += 1;
        report.counts.artifactVersions[placed.remapped ? "copied" : "restored"] += versions.length;
        remember(artifact.id, placed.id);
      } catch (error) {
        report.counts.artifacts.failed += 1;
        report.counts.artifactVersions.failed += versions.length;
        report.counts.notes.failed += notesByArtifact.get(artifact.id)?.length ?? 0;
        fail(artifact, error);
      }
    }

    signal?.throwIfAborted();
    if (report.counts.artifactTagsKept > 0) {
      report.warnings.push(
        `${report.counts.artifactTagsKept} tag link(s) from the archive were not added to artifacts that already existed; those artifacts kept their current tags`,
      );
    }
    if (report.counts.artifactTagsDropped > 0) {
      report.warnings.push(
        `${report.counts.artifactTagsDropped} tag link(s) were not restored: their tag was deleted or merged while the restore ran`,
      );
    }
    if (report.counts.collections.failed > 0) {
      report.warnings.push(
        `${report.counts.collections.failed} collection(s) were not restored: their parent was deleted or renamed while the restore ran, or merging them into this workspace's tree would nest them more than ${COLLECTION_MAX_DEPTH + 1} levels deep`,
      );
    }
    if (report.counts.collectionItemsKept > 0) {
      report.warnings.push(
        `${report.counts.collectionItemsKept} collection item(s) from the archive were not added to artifacts that already existed; those artifacts kept their current collections`,
      );
    }
    if (report.counts.collectionItemsDropped > 0) {
      report.warnings.push(
        `${report.counts.collectionItemsDropped} collection item(s) were not restored: their collection was not restored or was deleted while the restore ran`,
      );
    }
    report.durationMs = Date.now() - startedAt;
    return report;
  } finally {
    zip.close();
    await rm(tmp, { recursive: true, force: true });
  }
}
