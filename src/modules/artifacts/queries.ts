import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { DbExecutor } from "@/infrastructure/database/client";
import { beforeCursor, cursorTimestamp } from "@/infrastructure/database/keyset";
import {
  artifacts,
  artifactVersions,
  derivedAssets,
  documentSections,
  extractedDocuments,
  fileAssets,
} from "@/infrastructure/database/schema";
import type { KeysetCursor } from "@/lib/cursor";
import { notFound } from "@/lib/errors";
import type { Actor } from "@/modules/auth";

/**
 * Read models for artifacts. Every query is workspace-scoped and hides soft-deleted artifacts
 * (SECURITY.md §7): objects outside the actor's workspace are indistinguishable from missing ones.
 */
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
}

export async function listArtifacts(
  db: DbExecutor,
  actor: Actor,
  options: { limit: number; cursor?: KeysetCursor },
): Promise<{ items: ArtifactCard[]; nextCursor: KeysetCursor | null }> {
  const rows = await db
    .select({
      id: artifacts.id,
      title: artifacts.title,
      summary: artifacts.summary,
      visibility: artifacts.visibility,
      sensitivity: artifacts.sensitivity,
      createdAt: artifacts.createdAt,
      cursorCreatedAt: cursorTimestamp(artifacts.createdAt),
      updatedAt: artifacts.updatedAt,
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
    .where(
      and(
        eq(artifacts.workspaceId, actor.workspaceId),
        isNull(artifacts.deletedAt),
        beforeCursor(artifacts.createdAt, artifacts.id, options.cursor),
      ),
    )
    .orderBy(desc(artifacts.createdAt), desc(artifacts.id))
    .limit(options.limit + 1);

  const page = rows.slice(0, options.limit);
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
  }));
  const last = page.at(-1);
  return {
    items,
    nextCursor:
      rows.length > options.limit && last ? { createdAt: last.cursorCreatedAt, id: last.id } : null,
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
