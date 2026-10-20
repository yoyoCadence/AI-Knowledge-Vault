import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { Transform } from "node:stream";
import { eq } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";
import type { DbExecutor } from "@/infrastructure/database/client";
import {
  artifactVersions,
  documentSections,
  extractedDocuments,
  type derivedAssets,
} from "@/infrastructure/database/schema";
import { storageKeys, type StorageAdapter } from "@/infrastructure/storage";
import {
  analyzeArchive,
  ARCHIVE_ANALYZER_VERSION,
  contentHash,
  extractSingleFile,
  THUMBNAIL_GENERATOR,
  THUMBNAIL_GENERATOR_VERSION,
  ZipRejectedError,
  type ArchiveLimits,
  type ArchiveOutcome,
  type Classification,
  type ExtractionResult,
  type DetectedFormat,
  type SingleFileOutcome,
} from "@/modules/extraction";
import { sha256OfBuffer } from "@/modules/files/hash";

/**
 * Turns one stored original into a version's content: extracted text and sections, the
 * thumbnail, and the script-free preview files. Shared by the import pipeline and by restore
 * re-extraction (BACKUP_RECOVERY §6 step 7), so both produce identical results.
 *
 * Derived objects are written to storage here, before the caller's commit, under deterministic
 * ids derived from the version id: a retried run overwrites them instead of duplicating them.
 */

const ID_NAMESPACE = "4f6f1c1e-3b7a-5d2e-9c1a-6b2f0e8d7a10";
export const deterministicId = (name: string) => uuidv5(name, ID_NAMESPACE);

const SINGLE_HTML_PREVIEW_GENERATOR = "copy-original";
const ARCHIVE_PREVIEW_GENERATOR = "zip-extract";

export type DerivedInsert = typeof derivedAssets.$inferInsert;

export interface DerivedContent {
  extraction: ExtractionResult;
  classification: Classification;
  derived: DerivedInsert[];
  /** Set when an archive breaks a safety rule: the version keeps its original, no preview. */
  rejection?: { code: string; message: string };
}

export async function deriveVersionContent(input: {
  storage: StorageAdapter;
  workspaceId: string;
  versionId: string;
  /** Local copy of the original (already hashed by the caller). */
  filePath: string;
  filename: string;
  size: number;
  sha256: string;
  format: DetectedFormat;
  limits: ArchiveLimits;
  signal: AbortSignal;
}): Promise<DerivedContent> {
  const { storage, workspaceId, versionId, limits, signal } = input;
  const bytes = input.size <= limits.maxExtractBytes ? await readFile(input.filePath) : null;
  const outcome: SingleFileOutcome &
    Partial<Pick<ArchiveOutcome, "previewFiles" | "zip" | "rejection">> =
    input.format === "zip"
      ? await analyzeArchive(input.filePath, input.filename, limits)
      : await extractSingleFile({ bytes, filename: input.filename, format: input.format, limits });
  const derived: DerivedInsert[] = [];
  let { classification } = outcome;
  let rejection = outcome.rejection;
  try {
    signal.throwIfAborted();
    if (outcome.thumbnail) {
      const id = deterministicId(`derived:${versionId}:thumbnail:`);
      const key = storageKeys.derived(workspaceId, versionId, id);
      await storage.putObject(key, outcome.thumbnail.bytes, {
        contentType: outcome.thumbnail.mimeType,
      });
      derived.push({
        id,
        workspaceId,
        artifactVersionId: versionId,
        kind: "thumbnail",
        path: "",
        storageKey: key,
        mimeType: outcome.thumbnail.mimeType,
        byteSize: outcome.thumbnail.bytes.length,
        sha256: sha256OfBuffer(outcome.thumbnail.bytes),
        generator: THUMBNAIL_GENERATOR,
        generatorVersion: THUMBNAIL_GENERATOR_VERSION,
      });
    }
    if (
      input.format === "html" &&
      classification.previewKind === "static_html" &&
      classification.previewEntryPath
    ) {
      const path = classification.previewEntryPath;
      const id = deterministicId(`derived:${versionId}:preview_file:${path}`);
      const key = storageKeys.derived(workspaceId, versionId, id);
      await storage.putObject(key, createReadStream(input.filePath), {
        contentType: "text/html",
        contentLength: input.size,
      });
      derived.push({
        id,
        workspaceId,
        artifactVersionId: versionId,
        kind: "preview_file",
        path,
        storageKey: key,
        mimeType: "text/html",
        byteSize: input.size,
        sha256: input.sha256,
        generator: SINGLE_HTML_PREVIEW_GENERATOR,
        generatorVersion: 1,
      });
    }
    if (outcome.zip && outcome.previewFiles) {
      // Lying size headers in a non-entry file only surface while it streams. That rejects
      // the archive like any other integrity failure: the original is kept, no preview.
      let archiveError: ZipRejectedError | undefined;
      try {
        for (const file of outcome.previewFiles) {
          signal.throwIfAborted();
          const id = deterministicId(`derived:${versionId}:preview_file:${file.sitePath}`);
          const key = storageKeys.derived(workspaceId, versionId, id);
          const hash = createHash("sha256");
          const hashing = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              hash.update(chunk);
              callback(null, chunk);
            },
          });
          const source = await outcome.zip.openStream(file.archivePath);
          source.on("error", (error) => {
            if (error instanceof ZipRejectedError) archiveError = error;
            hashing.destroy(error);
          });
          // The adapter may await (mkdir, network) before it attaches its own listeners; an
          // early stream error must surface as putObject's rejection, never as an uncaught
          // 'error' event that would crash the worker.
          hashing.on("error", () => {});
          await storage.putObject(key, source.pipe(hashing), {
            contentType: file.mimeType,
            contentLength: file.size,
          });
          derived.push({
            id,
            workspaceId,
            artifactVersionId: versionId,
            kind: "preview_file",
            path: file.sitePath,
            storageKey: key,
            mimeType: file.mimeType,
            byteSize: file.size,
            sha256: hash.digest("hex"),
            generator: ARCHIVE_PREVIEW_GENERATOR,
            generatorVersion: ARCHIVE_ANALYZER_VERSION,
          });
        }
      } catch (error) {
        const cause = error instanceof ZipRejectedError ? error : archiveError;
        if (!cause) throw error;
        const previews = derived.filter((asset) => asset.kind === "preview_file");
        await Promise.all(
          previews.map((asset) => storage.deleteObject(asset.storageKey).catch(() => undefined)),
        );
        derived.splice(0, derived.length, ...derived.filter((asset) => !previews.includes(asset)));
        classification = { ...classification, previewKind: "unsupported", previewEntryPath: null };
        rejection = {
          code: "ARCHIVE_REJECTED",
          message: `${cause.message}. The original file was preserved for inspection.`,
        };
      }
    }
  } finally {
    outcome.zip?.close();
  }
  return { extraction: outcome.extraction, classification, derived, rejection };
}

/**
 * Stores an extraction (document + sections) and makes it the version's active extraction.
 * Returns the document id. Must run inside the caller's transaction.
 */
export async function saveExtraction(
  tx: DbExecutor,
  input: { workspaceId: string; versionId: string; extraction: ExtractionResult },
): Promise<string> {
  const { extraction } = input;
  const [document] = await tx
    .insert(extractedDocuments)
    .values({
      workspaceId: input.workspaceId,
      artifactVersionId: input.versionId,
      extractionMethod: extraction.method,
      extractionVersion: extraction.version,
      status: extraction.status,
      title: extraction.title,
      language: extraction.language,
      plainText: extraction.plainText,
      normalizedMarkdown: extraction.markdown,
      contentHash: extraction.plainText ? contentHash(extraction.plainText) : null,
      charCount: extraction.plainText.length,
      warnings: extraction.warnings,
      errorCode: extraction.errorCode ?? null,
      errorMessage: extraction.errorMessage ?? null,
    })
    .returning({ id: extractedDocuments.id });
  if (extraction.sections.length > 0) {
    await tx
      .insert(documentSections)
      .values(
        extraction.sections.map((section) => ({ ...section, extractedDocumentId: document!.id })),
      );
  }
  await tx
    .update(artifactVersions)
    .set({ activeExtractionId: document!.id })
    .where(eq(artifactVersions.id, input.versionId));
  return document!.id;
}
