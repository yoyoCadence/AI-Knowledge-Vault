import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Database, DbExecutor } from "@/infrastructure/database/client";
import {
  artifactFiles,
  artifacts,
  artifactVersions,
  fileAssets,
  researchProjects,
  type RestoreMode,
} from "@/infrastructure/database/schema";
import type { StorageAdapter } from "@/infrastructure/storage";
import { AppError, isAppError } from "@/lib/errors";
import { newId } from "@/lib/ids";
import { SafeZip, ZipRejectedError, type ZipLimits } from "@/modules/extraction";
import { storeOriginal } from "@/modules/files/originals";
import { deterministicId, saveExtraction } from "@/modules/imports/derive";
import { enqueueJob } from "@/modules/jobs";
import { enqueueVersionIndex } from "@/modules/search/indexer";
import {
  ArtifactFileV1,
  ArtifactV1,
  ChecksumFormatError,
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  FileAssetV1,
  hashFromOriginalPath,
  ManifestV1,
  normalizedPath,
  parseChecksums,
  PATHS,
  ProjectV1,
  VersionV1,
  type ManifestV1 as Manifest,
} from "./format";

/**
 * Restore of a format v1 archive into a workspace (docs/BACKUP_RECOVERY.md §6).
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

async function readJson<T>(zip: SafeZip, entryPath: string, schema: z.ZodType<T>): Promise<T> {
  if (!zip.has(entryPath)) throw invalidArchive(`${entryPath} is missing`);
  const raw = (await zip.readBuffer(entryPath, MAX_METADATA_BYTES)).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidArchive(`${entryPath} is not valid JSON`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw invalidArchive(`${entryPath} does not match export format v1`, {
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
  const manifest = await readJson(zip, PATHS.manifest, ManifestV1.loose());
  if (manifest.format !== EXPORT_FORMAT || manifest.formatVersion !== EXPORT_FORMAT_VERSION) {
    throw invalidArchive(`unsupported export format ${manifest.format} v${manifest.formatVersion}`);
  }
  await readJson(
    zip,
    PATHS.schemaVersion,
    z.object({ format: z.literal(EXPORT_FORMAT), formatVersion: z.literal(1) }).loose(),
  );
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

  // Primary ids must be unique: duplicates would silently collapse in the maps below, so a
  // version could be restored against the wrong original.
  const problems: string[] = [];
  const tables: [string, { id: string }[]][] = [
    ["project", projects],
    ["artifact", artifactList],
    ["version", versions],
    ["file asset", assets],
    ["artifact file", links],
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
  if (problems.length > 0) {
    throw invalidArchive("the archive's metadata is inconsistent", {
      problems: problems.slice(0, MAX_LISTED_PROBLEMS),
    });
  }
  return { manifest, verified: listed.size, projects, artifactList, versions, assets, links };
}

/** Postgres caps bind parameters at 65,535; id lookups are done in chunks well below that. */
const ID_CHUNK = 10_000;

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
    typeof artifacts | typeof researchProjects | typeof artifactVersions | typeof artifactFiles,
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
        await db.transaction(async (tx) => {
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
        });
        report.reextractJobs += versions.length;
        report.counts.artifacts[placed.remapped ? "copied" : "restored"] += 1;
        report.counts.artifactVersions[placed.remapped ? "copied" : "restored"] += versions.length;
        remember(artifact.id, placed.id);
      } catch (error) {
        report.counts.artifacts.failed += 1;
        report.counts.artifactVersions.failed += versions.length;
        fail(artifact, error);
      }
    }

    signal?.throwIfAborted();
    report.durationMs = Date.now() - startedAt;
    return report;
  } finally {
    zip.close();
    await rm(tmp, { recursive: true, force: true });
  }
}
