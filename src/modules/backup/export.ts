import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Transform, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { and, asc, eq, sql } from "drizzle-orm";
import yazl from "yazl";
import type { Database, DbExecutor } from "@/infrastructure/database/client";
import { MIGRATIONS_FOLDER } from "@/infrastructure/database/migrate";
import {
  artifactFiles,
  artifacts,
  artifactTags,
  artifactVersions,
  collectionItems,
  collections,
  extractedDocuments,
  fileAssets,
  researchProjects,
  tags,
  workspaces,
} from "@/infrastructure/database/schema";
import type { StorageAdapter } from "@/infrastructure/storage";
import { AppError } from "@/lib/errors";
import { APP_VERSION } from "@/lib/version";
import { sha256OfBuffer } from "@/modules/files/hash";
import {
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  exportFilename,
  formatChecksums,
  normalizedPath,
  originalPath,
  PATHS,
  README_TEXT,
  type ArtifactFileV1,
  type ArtifactTagV2,
  type ArtifactV1,
  type ChecksumEntry,
  type CollectionItemV3,
  type CollectionV3,
  type FileAssetV1,
  type ManifestV3,
  type ProjectV1,
  type TagV2,
  type VersionV1,
} from "./format";

/**
 * Portable export writer (docs/BACKUP_RECOVERY.md §2–3). Streams one workspace into a ZIP of
 * the latest format version: metadata JSON, normalized Markdown, and every original
 * byte-for-byte. Originals are re-hashed while streaming; if storage returns bytes that do not
 * match the recorded SHA-256 the export fails (ORIGINAL_CORRUPT) instead of producing an archive
 * whose checksums would lie. Read-only on the database; safe to run concurrently with normal use.
 */

export interface ExportSummary {
  filename: string;
  manifest: ManifestV3;
}

const iso = (value: Date | null) => (value ? value.toISOString() : null);

/** Tag of the newest applied migration (e.g. "0004_backup_runs"), or "#<count>" as fallback. */
export async function currentMigrationTag(db: DbExecutor): Promise<string> {
  const result = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
  );
  const count = Number(result.rows[0]?.n ?? 0);
  try {
    const journal = JSON.parse(
      await readFile(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
    ) as { entries: { idx: number; tag: string }[] };
    return journal.entries.find((entry) => entry.idx === count - 1)?.tag ?? `#${count}`;
  } catch {
    return `#${count}`;
  }
}

function yamlString(value: string): string {
  return JSON.stringify(value); // JSON strings are valid YAML double-quoted scalars
}

function normalizedDocument(args: {
  title: string | null;
  artifactId: string;
  versionId: string;
  versionNumber: number;
  language: string | null;
  method: string;
  methodVersion: number;
  markdown: string;
}): string {
  const front = [
    "---",
    `title: ${yamlString(args.title ?? "")}`,
    `artifact: ${args.artifactId}`,
    `version: ${args.versionId}`,
    `version_number: ${args.versionNumber}`,
    `language: ${args.language ? yamlString(args.language) : "null"}`,
    `extraction_method: ${yamlString(args.method)}`,
    `extraction_version: ${args.methodVersion}`,
    "---",
    "",
  ].join("\n");
  return `${front}${args.markdown}\n`;
}

const COMPRESSIBLE = /^(text\/|application\/(json|xml|xhtml\+xml|javascript))|markdown/;

/** Verifies the bytes of an original against its recorded hash as they flow into the ZIP. */
function verifyingStream(expected: string, label: string): Transform {
  const hash = createHash("sha256");
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      const actual = hash.digest("hex");
      callback(
        actual === expected
          ? null
          : new AppError("ORIGINAL_CORRUPT", `stored bytes of ${label} do not match its SHA-256`, {
              details: { expected, actual },
              retryable: false,
            }),
      );
    },
  });
}

/**
 * Reads every metadata row of the workspace inside ONE repeatable-read, read-only transaction,
 * so an import committing mid-export can never yield an archive whose versions reference an
 * artifact (or file) that is not in it. Originals are content-addressed and immutable, so their
 * bytes can safely be streamed after this snapshot is taken.
 */
async function readSnapshot(tx: DbExecutor, workspaceId: string) {
  const [workspace] = await tx
    .select({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (!workspace) throw new AppError("NOT_FOUND", "Workspace not found");

  const projectRows = await tx
    .select()
    .from(researchProjects)
    .where(eq(researchProjects.workspaceId, workspaceId))
    .orderBy(asc(researchProjects.createdAt), asc(researchProjects.id));
  const artifactRows = await tx
    .select()
    .from(artifacts)
    .where(eq(artifacts.workspaceId, workspaceId))
    .orderBy(asc(artifacts.createdAt), asc(artifacts.id));
  const versionRows = await tx
    .select()
    .from(artifactVersions)
    .where(eq(artifactVersions.workspaceId, workspaceId))
    .orderBy(asc(artifactVersions.artifactId), asc(artifactVersions.versionNumber));
  const assetRows = await tx
    .select()
    .from(fileAssets)
    .where(eq(fileAssets.workspaceId, workspaceId))
    .orderBy(asc(fileAssets.createdAt), asc(fileAssets.id));
  // Joins (not `IN (…)` over every id): no bind-parameter limit on large workspaces.
  const linkRows = await tx
    .select({ link: artifactFiles })
    .from(artifactFiles)
    .innerJoin(artifactVersions, eq(artifactVersions.id, artifactFiles.artifactVersionId))
    .where(eq(artifactVersions.workspaceId, workspaceId))
    .orderBy(asc(artifactFiles.createdAt), asc(artifactFiles.id))
    .then((rows) => rows.map((row) => row.link));
  const documents = await tx
    .select({ document: extractedDocuments })
    .from(extractedDocuments)
    .innerJoin(artifactVersions, eq(artifactVersions.activeExtractionId, extractedDocuments.id))
    .where(
      and(
        eq(artifactVersions.workspaceId, workspaceId),
        eq(extractedDocuments.workspaceId, workspaceId),
      ),
    )
    .then((rows) => rows.map((row) => row.document));
  const tagRows = await tx
    .select()
    .from(tags)
    .where(eq(tags.workspaceId, workspaceId))
    .orderBy(asc(tags.createdAt), asc(tags.id));
  const artifactTagRows = await tx
    .select()
    .from(artifactTags)
    .where(eq(artifactTags.workspaceId, workspaceId))
    .orderBy(asc(artifactTags.artifactId), asc(artifactTags.tagId));
  const collectionRows = await tx
    .select()
    .from(collections)
    .where(eq(collections.workspaceId, workspaceId))
    .orderBy(asc(collections.createdAt), asc(collections.id));
  const collectionItemRows = await tx
    .select()
    .from(collectionItems)
    .where(eq(collectionItems.workspaceId, workspaceId))
    .orderBy(asc(collectionItems.collectionId), asc(collectionItems.artifactId));
  return {
    workspace,
    projectRows,
    artifactRows,
    tagRows,
    artifactTagRows,
    collectionRows,
    collectionItemRows,
    versionRows,
    assetRows,
    linkRows,
    documents,
    dbMigration: await currentMigrationTag(tx),
  };
}

export async function writeExport(
  db: Database,
  storage: StorageAdapter,
  workspaceId: string,
  output: Writable,
  options: { now?: Date } = {},
): Promise<ExportSummary> {
  const now = options.now ?? new Date();
  // Observe the output before the first await: a stream that fails to open (an existing
  // `--out` file, a full or missing temp directory) emits 'error' asynchronously, and an
  // 'error' with no listener would crash the process instead of rejecting this export.
  const outputFailed = new Promise<never>((_, reject) => output.on("error", reject));
  outputFailed.catch(() => undefined);
  const reading = db.transaction((tx) => readSnapshot(tx, workspaceId), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
  reading.catch(() => undefined);
  const {
    workspace,
    projectRows,
    artifactRows,
    versionRows,
    assetRows,
    linkRows,
    tagRows,
    artifactTagRows,
    collectionRows,
    collectionItemRows,
    documents,
    dbMigration,
  } = await Promise.race([reading, outputFailed]);
  const documentById = new Map(documents.map((document) => [document.id, document]));

  const projects: ProjectV1[] = projectRows.map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: iso(row.deletedAt),
  }));
  const artifactJson: ArtifactV1[] = artifactRows.map((row) => ({
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    description: row.description,
    summary: row.summary,
    visibility: row.visibility,
    sensitivity: row.sensitivity,
    reviewStatus: row.reviewStatus,
    identityKey: row.identityKey,
    currentVersionId: row.currentVersionId,
    originRef: row.originRef,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: iso(row.deletedAt),
  }));
  const versions: VersionV1[] = versionRows.map((row) => ({
    id: row.id,
    artifactId: row.artifactId,
    versionNumber: row.versionNumber,
    primaryFileId: row.primaryFileId,
    contentKind: row.contentKind,
    previewKind: row.previewKind,
    previewEntryPath: row.previewEntryPath,
    contentHash: row.contentHash,
    sourcePlatform: row.sourcePlatform,
    sourceModel: row.sourceModel,
    originalPrompt: row.originalPrompt,
    sourceUrl: row.sourceUrl,
    researchDate: row.researchDate,
    author: row.author,
    referenceSources: row.referenceSources,
    changeSummary: row.changeSummary,
    analysis: row.analysis,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
  const assets: FileAssetV1[] = assetRows.map((row) => ({
    id: row.id,
    sha256: row.sha256,
    byteSize: row.byteSize,
    mimeType: row.mimeType,
    originalFilename: row.originalFilename,
    archivePath: originalPath(row.sha256, row.originalFilename),
    createdAt: row.createdAt.toISOString(),
  }));
  const links: ArtifactFileV1[] = linkRows.map((row) => ({
    id: row.id,
    artifactVersionId: row.artifactVersionId,
    fileAssetId: row.fileAssetId,
    role: row.role,
    displayName: row.displayName,
    createdAt: row.createdAt.toISOString(),
  }));

  const tagJson: TagV2[] = tagRows.map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
  const artifactTagJson: ArtifactTagV2[] = artifactTagRows.map((row) => ({
    artifactId: row.artifactId,
    tagId: row.tagId,
    createdAt: row.createdAt.toISOString(),
  }));
  const collectionJson: CollectionV3[] = collectionRows.map((row) => ({
    id: row.id,
    parentId: row.parentId,
    kind: row.kind,
    name: row.name,
    description: row.description,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
  const collectionItemJson: CollectionItemV3[] = collectionItemRows.map((row) => ({
    collectionId: row.collectionId,
    artifactId: row.artifactId,
    position: row.position,
    addedAt: row.addedAt.toISOString(),
  }));

  // Buffers whose bytes (and so hashes) are known up front.
  const buffers = new Map<string, Buffer>();
  const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  buffers.set(PATHS.readme, Buffer.from(README_TEXT, "utf8"));
  buffers.set(
    PATHS.schemaVersion,
    json({ format: EXPORT_FORMAT, formatVersion: EXPORT_FORMAT_VERSION, dbMigration }),
  );
  buffers.set(PATHS.workspace, json(workspace));
  buffers.set(PATHS.projects, json(projects));
  buffers.set(PATHS.artifacts, json(artifactJson));
  buffers.set(PATHS.versions, json(versions));
  buffers.set(PATHS.fileAssets, json(assets));
  buffers.set(PATHS.artifactFiles, json(links));
  buffers.set(PATHS.tags, json(tagJson));
  buffers.set(PATHS.artifactTags, json(artifactTagJson));
  buffers.set(PATHS.collections, json(collectionJson));
  buffers.set(PATHS.collectionItems, json(collectionItemJson));
  let normalizedCount = 0;
  for (const version of versionRows) {
    const document = version.activeExtractionId
      ? documentById.get(version.activeExtractionId)
      : undefined;
    if (!document || !document.normalizedMarkdown) continue;
    normalizedCount += 1;
    buffers.set(
      normalizedPath(version.id),
      Buffer.from(
        normalizedDocument({
          title: document.title,
          artifactId: version.artifactId,
          versionId: version.id,
          versionNumber: version.versionNumber,
          language: document.language,
          method: document.extractionMethod,
          methodVersion: document.extractionVersion,
          markdown: document.normalizedMarkdown,
        }),
        "utf8",
      ),
    );
  }

  const checksumEntries: ChecksumEntry[] = [
    ...[...buffers].map(([entryPath, bytes]) => ({
      path: entryPath,
      sha256: sha256OfBuffer(bytes),
    })),
    // Originals are content-addressed: the recorded hash *is* the checksum. It is re-verified
    // while streaming below, so a corrupt object aborts the export.
    ...assets.map((asset) => ({ path: asset.archivePath, sha256: asset.sha256 })),
  ];
  const checksums = Buffer.from(formatChecksums(checksumEntries), "utf8");
  const manifest: ManifestV3 = {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    createdAt: now.toISOString(),
    appVersion: APP_VERSION,
    dbMigration,
    encryption: "none",
    workspace,
    counts: {
      researchProjects: projects.length,
      artifacts: artifactJson.length,
      artifactVersions: versions.length,
      fileAssets: assets.length,
      artifactFiles: links.length,
      normalizedDocuments: normalizedCount,
      tags: tagJson.length,
      artifactTags: artifactTagJson.length,
      collections: collectionJson.length,
      collectionItems: collectionItemJson.length,
    },
    checksumsSha256: sha256OfBuffer(checksums),
  };

  const zip = new yazl.ZipFile();
  const mtime = now;
  // Any stream failure (storage error, ORIGINAL_CORRUPT from the verifier) is routed to the
  // zip's 'error' event, which fails the export. Nothing may be left as an unhandled 'error'
  // event: that would crash the worker process.
  const failed = new Promise<never>((_, reject) => zip.once("error", reject));
  failed.catch(() => undefined);
  zip.addBuffer(buffers.get(PATHS.readme)!, PATHS.readme, { mtime });
  zip.addBuffer(json(manifest), PATHS.manifest, { mtime });
  for (const [entryPath, bytes] of buffers) {
    if (entryPath === PATHS.readme) continue;
    zip.addBuffer(bytes, entryPath, { mtime });
  }
  for (const asset of assetRows) {
    const archivePath = originalPath(asset.sha256, asset.originalFilename);
    zip.addReadStreamLazy(
      archivePath,
      { mtime, size: asset.byteSize, compress: COMPRESSIBLE.test(asset.mimeType) },
      (callback) => {
        storage
          .getObject(asset.storageKey)
          .then(({ body }) => {
            const verify = verifyingStream(asset.sha256, archivePath);
            body.on("error", (error) => verify.destroy(error));
            verify.on("error", (error) => zip.emit("error", error));
            callback(null, body.pipe(verify));
          })
          .catch((error: unknown) => callback(error, undefined as never));
      },
    );
  }
  zip.addBuffer(checksums, PATHS.checksums, { mtime });
  zip.end();

  const writing = pipeline(zip.outputStream, output);
  writing.catch(() => undefined);
  try {
    await Promise.race([writing, failed, outputFailed]);
  } catch (error) {
    // Stop writing a truncated archive; callers delete their partial output.
    (zip.outputStream as unknown as { destroy(error?: Error): void }).destroy();
    output.destroy();
    throw error;
  }
  return { filename: exportFilename(workspace.slug, now), manifest };
}
