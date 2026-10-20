import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { DbExecutor } from "@/infrastructure/database/client";
import {
  artifacts,
  artifactVersions,
  derivedAssets,
  fileAssets,
} from "@/infrastructure/database/schema";
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
  options: { limit: number; cursor?: { createdAt: Date; id: string } },
): Promise<{ items: ArtifactCard[]; nextCursor: { createdAt: Date; id: string } | null }> {
  const rows = await db
    .select({
      id: artifacts.id,
      title: artifacts.title,
      summary: artifacts.summary,
      visibility: artifacts.visibility,
      sensitivity: artifacts.sensitivity,
      createdAt: artifacts.createdAt,
      updatedAt: artifacts.updatedAt,
      versionId: artifactVersions.id,
      versionNumber: artifactVersions.versionNumber,
      contentKind: artifactVersions.contentKind,
      previewKind: artifactVersions.previewKind,
      sourcePlatform: artifactVersions.sourcePlatform,
      sourceModel: artifactVersions.sourceModel,
      processingStatus: artifactVersions.processingStatus,
      versionCount: sql<number>`(select count(*)::int from ${artifactVersions} v where v.artifact_id = ${artifacts.id})`,
      hasThumbnail: sql<boolean>`exists (select 1 from ${derivedAssets} d where d.artifact_version_id = ${artifacts.currentVersionId} and d.kind = 'thumbnail')`,
    })
    .from(artifacts)
    .leftJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
    .where(
      and(
        eq(artifacts.workspaceId, actor.workspaceId),
        isNull(artifacts.deletedAt),
        options.cursor
          ? or(
              lt(artifacts.createdAt, options.cursor.createdAt),
              and(
                eq(artifacts.createdAt, options.cursor.createdAt),
                lt(artifacts.id, options.cursor.id),
              ),
            )
          : undefined,
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
      rows.length > options.limit && last ? { createdAt: last.createdAt, id: last.id } : null,
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
