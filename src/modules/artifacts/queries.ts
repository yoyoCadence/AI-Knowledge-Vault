import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { DbExecutor } from "@/infrastructure/database/client";
import { afterCursor, beforeCursor, cursorTimestamp } from "@/infrastructure/database/keyset";
import {
  artifactReadingStates,
  artifacts,
  artifactTags,
  artifactVersions,
  derivedAssets,
  documentSections,
  extractedDocuments,
  fileAssets,
  type ReadingStatus,
  tags,
} from "@/infrastructure/database/schema";
import type { KeysetCursor } from "@/lib/cursor";
import { notFound } from "@/lib/errors";
import type { Actor } from "@/modules/auth";
import { filterConditions, type LibraryFilters } from "./filters";

/**
 * Read models for artifacts. Every query is workspace-scoped and hides soft-deleted artifacts
 * (SECURITY.md §7): objects outside the actor's workspace are indistinguishable from missing ones.
 */
/** `opened`: the artifacts the actor opened, most recently opened first. */
export const LIBRARY_SORTS = ["newest", "oldest", "opened"] as const;
export type LibrarySort = (typeof LIBRARY_SORTS)[number];

export interface TagSummary {
  id: string;
  name: string;
}

export interface ArtifactCard {
  id: string;
  title: string;
  summary: string | null;
  visibility: string;
  sensitivity: string;
  createdAt: Date;
  updatedAt: Date;
  currentVersion: {
    id: string;
    versionNumber: number;
    contentKind: string;
    previewKind: string;
    sourcePlatform: string | null;
    sourceModel: string | null;
    processingStatus: string;
  } | null;
  versionCount: number;
  hasThumbnail: boolean;
  tags: TagSummary[];
  /** The actor's own reading state (unread when they never touched it). */
  readingStatus: ReadingStatus;
  isFavorite: boolean;
  lastOpenedAt: Date | null;
}

/** Source models recorded on current versions of the actor's artifacts, for the filter. */
export async function listSourceModels(db: DbExecutor, actor: Actor): Promise<string[]> {
  const rows = await db
    .selectDistinct({ model: artifactVersions.sourceModel })
    .from(artifacts)
    .innerJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
    .where(
      and(
        eq(artifacts.workspaceId, actor.workspaceId),
        isNull(artifacts.deletedAt),
        sql`${artifactVersions.sourceModel} is not null`,
      ),
    )
    .orderBy(asc(artifactVersions.sourceModel))
    .limit(200);
  return rows.map((row) => row.model!);
}

/** Tags of many artifacts at once, keyed by artifact id. Callers pass ids they may see. */
export async function tagsByArtifact(
  db: DbExecutor,
  workspaceId: string,
  artifactIds: string[],
): Promise<Map<string, TagSummary[]>> {
  const result = new Map<string, TagSummary[]>();
  if (artifactIds.length === 0) return result;
  const rows = await db
    .select({ artifactId: artifactTags.artifactId, id: tags.id, name: tags.name })
    .from(artifactTags)
    .innerJoin(tags, eq(tags.id, artifactTags.tagId))
    .where(
      and(eq(artifactTags.workspaceId, workspaceId), inArray(artifactTags.artifactId, artifactIds)),
    )
    .orderBy(asc(tags.normalizedName));
  for (const row of rows) {
    const list = result.get(row.artifactId) ?? [];
    list.push({ id: row.id, name: row.name });
    result.set(row.artifactId, list);
  }
  return result;
}

export async function listArtifacts(
  db: DbExecutor,
  actor: Actor,
  options: {
    limit: number;
    cursor?: KeysetCursor;
    filters?: LibraryFilters;
    /**
     * newest (default) or oldest first, or `opened` (only the artifacts the actor opened, most
     * recently opened first); the cursor continues in that order.
     */
    sort?: LibrarySort;
  },
): Promise<{ items: ArtifactCard[]; nextCursor: KeysetCursor | null }> {
  const oldest = options.sort === "oldest";
  const opened = options.sort === "opened";
  // The `opened` cursor carries `last_opened_at` in its timestamp field.
  const position = opened
    ? [
        isNotNull(artifactReadingStates.lastOpenedAt),
        beforeCursor(artifactReadingStates.lastOpenedAt, artifacts.id, options.cursor),
      ]
    : oldest
      ? [afterCursor(artifacts.createdAt, artifacts.id, options.cursor)]
      : [beforeCursor(artifacts.createdAt, artifacts.id, options.cursor)];
  const rows = await db
    .select({
      id: artifacts.id,
      title: artifacts.title,
      summary: artifacts.summary,
      visibility: artifacts.visibility,
      sensitivity: artifacts.sensitivity,
      createdAt: artifacts.createdAt,
      cursorCreatedAt: cursorTimestamp(artifacts.createdAt),
      cursorOpenedAt: cursorTimestamp(artifactReadingStates.lastOpenedAt),
      updatedAt: artifacts.updatedAt,
      readingStatus: artifactReadingStates.status,
      isFavorite: artifactReadingStates.isFavorite,
      lastOpenedAt: artifactReadingStates.lastOpenedAt,
      versionId: artifactVersions.id,
      versionNumber: artifactVersions.versionNumber,
      contentKind: artifactVersions.contentKind,
      previewKind: artifactVersions.previewKind,
      sourcePlatform: artifactVersions.sourcePlatform,
      sourceModel: artifactVersions.sourceModel,
      processingStatus: artifactVersions.processingStatus,
      // Outer columns are referenced as "artifacts".<col> explicitly: drizzle may render bare
      // column names, which would silently bind to the subquery's own table.
      versionCount: sql<number>`(select count(*)::int from ${artifactVersions} v where v.artifact_id = ${artifacts}.id)`,
      hasThumbnail: sql<boolean>`exists (select 1 from ${derivedAssets} d where d.artifact_version_id = ${artifacts}.current_version_id and d.kind = 'thumbnail')`,
    })
    .from(artifacts)
    .leftJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
    .leftJoin(
      artifactReadingStates,
      and(
        eq(artifactReadingStates.artifactId, artifacts.id),
        eq(artifactReadingStates.userId, actor.userId),
      ),
    )
    .where(
      and(
        eq(artifacts.workspaceId, actor.workspaceId),
        isNull(artifacts.deletedAt),
        ...position,
        ...filterConditions(sql.identifier("artifacts"), options.filters ?? {}, actor.userId),
      ),
    )
    .orderBy(
      ...(opened
        ? [desc(artifactReadingStates.lastOpenedAt), desc(artifacts.id)]
        : oldest
          ? [asc(artifacts.createdAt), asc(artifacts.id)]
          : [desc(artifacts.createdAt), desc(artifacts.id)]),
    )
    .limit(options.limit + 1);

  const page = rows.slice(0, options.limit);
  const tagMap = await tagsByArtifact(
    db,
    actor.workspaceId,
    page.map((row) => row.id),
  );
  const items: ArtifactCard[] = page.map((row) => ({
    id: row.id,
    title: row.title,
    summary: row.summary,
    visibility: row.visibility,
    sensitivity: row.sensitivity,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    currentVersion: row.versionId
      ? {
          id: row.versionId,
          versionNumber: row.versionNumber!,
          contentKind: row.contentKind!,
          previewKind: row.previewKind!,
          sourcePlatform: row.sourcePlatform,
          sourceModel: row.sourceModel,
          processingStatus: row.processingStatus!,
        }
      : null,
    versionCount: row.versionCount,
    hasThumbnail: row.hasThumbnail,
    tags: tagMap.get(row.id) ?? [],
    readingStatus: row.readingStatus ?? "unread",
    isFavorite: row.isFavorite ?? false,
    lastOpenedAt: row.lastOpenedAt,
  }));
  const last = page.at(-1);
  return {
    items,
    nextCursor:
      rows.length > options.limit && last
        ? { createdAt: opened ? last.cursorOpenedAt : last.cursorCreatedAt, id: last.id }
        : null,
  };
}

/** Loads an artifact the actor may see, or throws NOT_FOUND. */
export async function getArtifactForActor(db: DbExecutor, actor: Actor, artifactId: string) {
  const [artifact] = await db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.id, artifactId),
        eq(artifacts.workspaceId, actor.workspaceId),
        isNull(artifacts.deletedAt),
      ),
    );
  if (!artifact) throw notFound("Artifact");
  return artifact;
}

export async function getArtifactDetail(db: DbExecutor, actor: Actor, artifactId: string) {
  const artifact = await getArtifactForActor(db, actor, artifactId);
  const versions = await db
    .select({
      id: artifactVersions.id,
      versionNumber: artifactVersions.versionNumber,
      contentKind: artifactVersions.contentKind,
      previewKind: artifactVersions.previewKind,
      previewStatus: artifactVersions.previewStatus,
      processingStatus: artifactVersions.processingStatus,
      sourcePlatform: artifactVersions.sourcePlatform,
      sourceModel: artifactVersions.sourceModel,
      researchDate: artifactVersions.researchDate,
      changeSummary: artifactVersions.changeSummary,
      createdAt: artifactVersions.createdAt,
      originalFilename: fileAssets.originalFilename,
      byteSize: fileAssets.byteSize,
      sha256: fileAssets.sha256,
      mimeType: fileAssets.mimeType,
    })
    .from(artifactVersions)
    .innerJoin(fileAssets, eq(fileAssets.id, artifactVersions.primaryFileId))
    .where(eq(artifactVersions.artifactId, artifact.id))
    .orderBy(desc(artifactVersions.versionNumber));
  return { artifact, versions };
}

/** Loads a version of a visible artifact together with its primary original, or NOT_FOUND. */
export async function getVersionWithOriginal(
  db: DbExecutor,
  actor: Actor,
  artifactId: string,
  versionId: string,
) {
  const [row] = await db
    .select({ version: artifactVersions, file: fileAssets })
    .from(artifactVersions)
    .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
    .innerJoin(fileAssets, eq(fileAssets.id, artifactVersions.primaryFileId))
    .where(
      and(
        eq(artifactVersions.id, versionId),
        eq(artifactVersions.artifactId, artifactId),
        eq(artifacts.workspaceId, actor.workspaceId),
        isNull(artifacts.deletedAt),
      ),
    );
  if (!row) throw notFound("Version");
  return row;
}

/** Version detail for the artifact page: extraction summary, outline and references. */
export async function getVersionOverview(
  db: DbExecutor,
  actor: Actor,
  artifactId: string,
  versionId: string,
) {
  const { version, file } = await getVersionWithOriginal(db, actor, artifactId, versionId);
  const [document] = version.activeExtractionId
    ? await db
        .select({
          id: extractedDocuments.id,
          status: extractedDocuments.status,
          language: extractedDocuments.language,
          charCount: extractedDocuments.charCount,
          warnings: extractedDocuments.warnings,
          errorCode: extractedDocuments.errorCode,
          errorMessage: extractedDocuments.errorMessage,
        })
        .from(extractedDocuments)
        .where(eq(extractedDocuments.id, version.activeExtractionId))
    : [];
  const outline = document
    ? await db
        .select({
          heading: documentSections.heading,
          level: documentSections.level,
          anchor: documentSections.anchor,
        })
        .from(documentSections)
        .innerJoin(
          extractedDocuments,
          eq(extractedDocuments.id, documentSections.extractedDocumentId),
        )
        .where(
          and(
            eq(documentSections.extractedDocumentId, document.id),
            eq(extractedDocuments.workspaceId, actor.workspaceId),
          ),
        )
        .orderBy(asc(documentSections.ordinal))
    : [];
  // A restored image's thumbnail only exists once re-extraction has regenerated it.
  const [thumbnail] = await db
    .select({ id: derivedAssets.id })
    .from(derivedAssets)
    .where(
      and(
        eq(derivedAssets.artifactVersionId, version.id),
        eq(derivedAssets.workspaceId, actor.workspaceId),
        eq(derivedAssets.kind, "thumbnail"),
      ),
    )
    .limit(1);
  return {
    version,
    file: {
      id: file.id,
      originalFilename: file.originalFilename,
      byteSize: file.byteSize,
      sha256: file.sha256,
      mimeType: file.mimeType,
      storageStatus: file.storageStatus,
      integrityVerifiedAt: file.integrityVerifiedAt,
    },
    extraction: document ?? null,
    outline: outline.filter((section) => section.heading),
    hasThumbnail: Boolean(thumbnail),
  };
}

/**
 * Reading-mode content of a version (FR-LIB-4): its active extraction's normalized Markdown
 * and sections, or null when it has none. Scoped like every read: out-of-workspace is 404.
 */
export async function getVersionContent(
  db: DbExecutor,
  actor: Actor,
  artifactId: string,
  versionId: string,
) {
  const { version } = await getVersionWithOriginal(db, actor, artifactId, versionId);
  if (!version.activeExtractionId) return null;
  const [document] = await db
    .select({
      id: extractedDocuments.id,
      method: extractedDocuments.extractionMethod,
      status: extractedDocuments.status,
      title: extractedDocuments.title,
      language: extractedDocuments.language,
      markdown: extractedDocuments.normalizedMarkdown,
      warnings: extractedDocuments.warnings,
    })
    .from(extractedDocuments)
    .where(
      and(
        eq(extractedDocuments.id, version.activeExtractionId),
        eq(extractedDocuments.workspaceId, actor.workspaceId),
      ),
    );
  if (!document) return null;
  const sections = await db
    .select({
      ordinal: documentSections.ordinal,
      level: documentSections.level,
      heading: documentSections.heading,
      anchor: documentSections.anchor,
    })
    .from(documentSections)
    .innerJoin(extractedDocuments, eq(extractedDocuments.id, documentSections.extractedDocumentId))
    .where(
      and(
        eq(documentSections.extractedDocumentId, document.id),
        eq(extractedDocuments.workspaceId, actor.workspaceId),
      ),
    )
    .orderBy(asc(documentSections.ordinal));
  const { id: _id, ...extraction } = document;
  return { contentKind: version.contentKind, extraction, sections };
}

export type VersionContent = NonNullable<Awaited<ReturnType<typeof getVersionContent>>>;
