import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Database, DbExecutor } from "@/infrastructure/database/client";
import {
  artifactNotes,
  artifacts,
  artifactSearchDocuments,
  artifactTags,
  artifactVersions,
  contentChunks,
  documentSections,
  extractedDocuments,
  fileAssets,
  searchIndexStates,
  tags,
} from "@/infrastructure/database/schema";
import { enqueueJob, type JobDefinition } from "@/modules/jobs";
import { chunkText } from "./chunks";
import { TOKENIZER_VERSION, toTsvector } from "./tokenizer";

/**
 * Search indexing lifecycle (docs/SEARCH_DESIGN.md §6). Index rows are derived data: a
 * version's chunks are rebuilt from its active extraction, an artifact's metadata document
 * from its row and current version. Every write replaces what was there, so re-running is
 * always safe.
 */

export const SEARCH_INDEX_JOB_TYPE = "search.index_version";
export const SEARCH_REINDEX_ALL_JOB_TYPE = "search.reindex_all";
const INSERT_BATCH = 200;
/**
 * Metadata indexed per field, in characters (tags: how many; notes: characters in all, newest
 * notes first). A tsvector holds at most 1 MB, and an unbounded description (from an edited
 * archive, say) would fail the whole index job every time. The full text stays in the
 * database; only the searchable copy is capped.
 */
const METADATA_LIMITS = {
  title: 500,
  text: 5_000,
  source: 500,
  tags: 200,
  notes: 20_000,
  noteCount: 200,
} as const;

/** Newest first, until `budget` characters are used: the notes a search covers. */
function noteParts(bodies: string[], budget: number): string[] {
  const parts: string[] = [];
  for (const body of bodies) {
    if (budget <= 0) break;
    const part = clip(body, budget);
    parts.push(part);
    budget -= Array.from(part).length;
  }
  return parts;
}

/** The first `max` characters (code points, never half a surrogate pair). */
function clip(text: string | null | undefined, max: number): string {
  if (!text) return "";
  return text.length <= max ? text : Array.from(text).slice(0, max).join("");
}

/**
 * Queues indexing of a version's newly saved extraction. Call inside the transaction that
 * saved it, so the job exists exactly when the extraction does. Keyed by extraction and
 * tokenizer version: a re-extraction or a tokenizer upgrade indexes again, a retry does not.
 * A version without an extraction (a restore that had no archived text) is keyed by the
 * version: its job builds the metadata document, so the artifact is found by title.
 */
export async function enqueueVersionIndex(
  tx: DbExecutor,
  input: {
    workspaceId: string;
    versionId: string;
    extractionId: string | null;
    keySuffix?: string;
  },
) {
  const source = input.extractionId ?? `version:${input.versionId}`;
  const key = `${SEARCH_INDEX_JOB_TYPE}:${source}:${TOKENIZER_VERSION}`;
  await enqueueJob(tx, {
    type: SEARCH_INDEX_JOB_TYPE,
    idempotencyKey: input.keySuffix ? `${key}:${input.keySuffix}` : key,
    workspaceId: input.workspaceId,
    payload: { versionId: input.versionId },
  });
}

/**
 * Rebuilds an artifact's metadata search document from its row, its tags, its notes and its
 * current version (title A; description, summary and tags B; notes and source fields C). Call it
 * inside a transaction: the artifact row is locked first, so a version that becomes current
 * while this runs is either read here or waits until this document is written. Without the
 * lock, a slower job for the old version could overwrite the new version's document.
 */
export async function indexArtifactMetadata(tx: DbExecutor, artifactId: string) {
  const [locked] = await tx
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(eq(artifacts.id, artifactId))
    .for("update");
  if (!locked) return;
  const [row] = await tx
    .select({
      workspaceId: artifacts.workspaceId,
      title: artifacts.title,
      description: artifacts.description,
      summary: artifacts.summary,
      sourcePlatform: artifactVersions.sourcePlatform,
      sourceModel: artifactVersions.sourceModel,
      author: artifactVersions.author,
      filename: fileAssets.originalFilename,
    })
    .from(artifacts)
    .leftJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
    .leftJoin(fileAssets, eq(fileAssets.id, artifactVersions.primaryFileId))
    .where(eq(artifacts.id, artifactId));
  if (!row) return;
  const tagRows = await tx
    .select({ name: tags.name })
    .from(artifactTags)
    .innerJoin(tags, eq(tags.id, artifactTags.tagId))
    .where(eq(artifactTags.artifactId, artifactId))
    .orderBy(asc(tags.normalizedName))
    .limit(METADATA_LIMITS.tags);
  // Only what can be indexed is read: the newest notes, each cut to the whole budget.
  const noteRows = await tx
    .select({ body: sql<string>`left(${artifactNotes.bodyMarkdown}, ${METADATA_LIMITS.notes})` })
    .from(artifactNotes)
    .where(eq(artifactNotes.artifactId, artifactId))
    .orderBy(desc(artifactNotes.createdAt), desc(artifactNotes.id))
    .limit(METADATA_LIMITS.noteCount);
  const searchVector = toTsvector([
    { text: clip(row.title, METADATA_LIMITS.title), weight: "A" },
    {
      text: [row.description, row.summary]
        .map((text) => clip(text, METADATA_LIMITS.text))
        .filter(Boolean)
        .join("\n"),
      weight: "B",
    },
    // One part per tag: a phrase never runs from one tag into the next.
    ...tagRows.map((tag) => ({ text: tag.name, weight: "B" as const })),
    {
      text: [row.sourcePlatform, row.sourceModel, row.author, row.filename]
        .map((text) => clip(text, METADATA_LIMITS.source))
        .filter(Boolean)
        .join("\n"),
      weight: "C",
    },
    // Notes last (newest first, one part each, like tags): they can be long, and positions
    // past the tsvector's last one are left out, so they must not crowd out the fields above.
    ...noteParts(
      noteRows.map((note) => note.body),
      METADATA_LIMITS.notes,
    ).map((text) => ({ text, weight: "C" as const })),
  ]);
  await tx
    .insert(artifactSearchDocuments)
    .values({
      artifactId,
      workspaceId: row.workspaceId,
      searchVector,
      tokenizerVersion: TOKENIZER_VERSION,
    })
    .onConflictDoUpdate({
      target: artifactSearchDocuments.artifactId,
      set: { searchVector, tokenizerVersion: TOKENIZER_VERSION, updatedAt: new Date() },
    });
}

/**
 * Job handler: replaces the version's chunks with chunks of its active extraction, records
 * what they were built from (`search_index_states`) and refreshes its artifact's metadata
 * document, in one transaction. Locks, in order: the version row (two jobs for the same
 * version never interleave), then its artifact row (jobs for different versions of one
 * artifact take turns). Nothing locks an existing version after its artifact, so this order
 * cannot deadlock with imports, restores or re-extraction; source edits (`updateVersionSource`)
 * take the same order. Keep it that way: the reverse order deadlocks with this job.
 */
export async function indexVersion(db: Database, versionId: string) {
  return db.transaction(async (tx) => {
    const [version] = await tx
      .select({
        id: artifactVersions.id,
        workspaceId: artifactVersions.workspaceId,
        artifactId: artifactVersions.artifactId,
        activeExtractionId: artifactVersions.activeExtractionId,
      })
      .from(artifactVersions)
      .where(eq(artifactVersions.id, versionId))
      .for("update");
    if (!version) return { skipped: "missing_version" };
    // The artifact row next, before any chunk is written: a chunk's foreign key takes a
    // key-share lock on the artifact, and two jobs for versions of the same artifact that each
    // held one while waiting to lock the artifact for its metadata document would deadlock.
    await tx
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(eq(artifacts.id, version.artifactId))
      .for("update");

    await tx.delete(contentChunks).where(eq(contentChunks.artifactVersionId, version.id));
    let chunkCount = 0;
    if (version.activeExtractionId) {
      const [document] = await tx
        .select({ id: extractedDocuments.id, plainText: extractedDocuments.plainText })
        .from(extractedDocuments)
        .where(eq(extractedDocuments.id, version.activeExtractionId));
      const sections = document
        ? await tx
            .select({
              id: documentSections.id,
              ordinal: documentSections.ordinal,
              charStart: documentSections.charStart,
              charEnd: documentSections.charEnd,
            })
            .from(documentSections)
            .where(eq(documentSections.extractedDocumentId, document.id))
            .orderBy(asc(documentSections.ordinal))
        : [];
      if (document?.plainText) {
        const sectionIds = new Map(sections.map((section) => [section.ordinal, section.id]));
        const rows = chunkText(document.plainText, sections).map((chunk) => ({
          workspaceId: version.workspaceId,
          artifactId: version.artifactId,
          artifactVersionId: version.id,
          extractedDocumentId: document.id,
          sectionId:
            chunk.sectionOrdinal === null ? null : (sectionIds.get(chunk.sectionOrdinal) ?? null),
          ordinal: chunk.ordinal,
          text: chunk.text,
          charStart: chunk.charStart,
          charEnd: chunk.charEnd,
          contentHash: createHash("sha256").update(chunk.text).digest("hex"),
          tokenizerVersion: TOKENIZER_VERSION,
          searchVector: toTsvector([{ text: chunk.text, weight: "D" }]),
        }));
        for (let index = 0; index < rows.length; index += INSERT_BATCH) {
          await tx.insert(contentChunks).values(rows.slice(index, index + INSERT_BATCH));
        }
        chunkCount = rows.length;
      }
    }
    const state = {
      workspaceId: version.workspaceId,
      extractedDocumentId: version.activeExtractionId,
      tokenizerVersion: TOKENIZER_VERSION,
      chunkCount,
      indexedAt: new Date(),
    };
    await tx
      .insert(searchIndexStates)
      .values({ artifactVersionId: version.id, ...state })
      .onConflictDoUpdate({ target: searchIndexStates.artifactVersionId, set: state });
    await indexArtifactMetadata(tx, version.artifactId);
    return { versionId: version.id, chunks: chunkCount };
  });
}

/**
 * Backfill / safety net: queues an index job for every current version that was never
 * indexed from its active extraction with this tokenizer (per `search_index_states`), and
 * for every artifact without a current metadata document. Cheap when nothing is missing, so
 * the scheduler runs it daily; it also indexes everything imported before search existed.
 */
export async function enqueueMissingIndexes(db: Database, now = new Date()): Promise<number> {
  // Its own key per day: a version whose first index job failed for good is retried daily.
  const keySuffix = `backfill:${now.toISOString().slice(0, 10)}`;
  let queued = 0;
  let afterId: string | null = null;
  for (;;) {
    const page: { versionId: string; workspaceId: string; extractionId: string | null }[] = await db
      .select({
        versionId: artifactVersions.id,
        workspaceId: artifactVersions.workspaceId,
        extractionId: artifactVersions.activeExtractionId,
      })
      .from(artifacts)
      .innerJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
      .where(
        and(
          isNull(artifacts.deletedAt),
          afterId ? gt(artifactVersions.id, afterId) : undefined,
          sql`(
              not exists (
                select 1 from ${searchIndexStates} s
                where s.artifact_version_id = ${artifactVersions.id}
                  and s.extracted_document_id is not distinct from ${artifactVersions.activeExtractionId}
                  and s.tokenizer_version = ${TOKENIZER_VERSION}
              )
              or not exists (
                select 1 from ${artifactSearchDocuments} d
                where d.artifact_id = ${artifacts.id} and d.tokenizer_version = ${TOKENIZER_VERSION}
              )
            )`,
        ),
      )
      .orderBy(asc(artifactVersions.id))
      .limit(500);
    for (const row of page) {
      await enqueueVersionIndex(db, { ...row, keySuffix });
      queued += 1;
    }
    if (page.length < 500) return queued;
    afterId = page.at(-1)!.versionId;
  }
}

export function searchIndexJobDefinition(): JobDefinition {
  return {
    type: SEARCH_INDEX_JOB_TYPE,
    timeoutMs: 5 * 60 * 1000,
    handler: async ({ db, job }) => indexVersion(db, String(job.payload.versionId ?? "")),
  };
}

export function searchReindexAllJobDefinition(): JobDefinition {
  return {
    type: SEARCH_REINDEX_ALL_JOB_TYPE,
    timeoutMs: 10 * 60 * 1000,
    handler: async ({ db }) => ({ queued: await enqueueMissingIndexes(db) }),
  };
}
