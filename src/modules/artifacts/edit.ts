import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "@/infrastructure/database/client";
import { artifacts, artifactVersions, researchProjects } from "@/infrastructure/database/schema";
import { AppError, notFound } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { cleanDescription, cleanTitle } from "@/lib/text";
import { linkableUrl } from "@/lib/url";
import { recordAudit, type RequestMeta } from "@/modules/audit";
import type { Actor } from "@/modules/auth";
import { indexArtifactMetadata } from "@/modules/search";

/**
 * Editing an artifact's own metadata (API_CONTRACT §5 `PATCH /api/artifacts/:id`): title,
 * description and research project. Originals and versions are never touched. Title and
 * description are search metadata, so the artifact is re-indexed in the same transaction.
 */

export const ARTIFACT_TITLE_MAX = 500;
export const ARTIFACT_DESCRIPTION_MAX = 5_000;

export interface ArtifactEdit {
  title?: string;
  description?: string | null;
  /** null takes the artifact out of its project. */
  projectId?: string | null;
}

export async function updateArtifact(
  db: Database,
  actor: Actor,
  artifactId: string,
  edit: ArtifactEdit,
  meta: RequestMeta,
) {
  const changes: Partial<typeof artifacts.$inferInsert> = {};
  if (edit.title !== undefined) changes.title = cleanTitle(edit.title, ARTIFACT_TITLE_MAX);
  if (edit.description !== undefined)
    changes.description = cleanDescription(edit.description, ARTIFACT_DESCRIPTION_MAX);
  if (edit.projectId !== undefined) changes.projectId = edit.projectId;
  if (Object.keys(changes).length === 0) {
    throw new AppError("VALIDATION_FAILED", "Nothing to update");
  }
  return db.transaction(async (tx) => {
    const [artifact] = await tx
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.id, artifactId),
          eq(artifacts.workspaceId, actor.workspaceId),
          isNull(artifacts.deletedAt),
        ),
      )
      .for("update");
    if (!artifact) throw notFound("Artifact");
    if (edit.projectId) {
      // A project of another workspace, or a deleted one, does not exist for this actor.
      const [project] = await tx
        .select({ id: researchProjects.id })
        .from(researchProjects)
        .where(
          and(
            eq(researchProjects.id, edit.projectId),
            eq(researchProjects.workspaceId, actor.workspaceId),
            isNull(researchProjects.deletedAt),
          ),
        )
        .for("share");
      if (!project) throw notFound("Research project");
    }
    const [updated] = await tx
      .update(artifacts)
      .set(changes)
      .where(eq(artifacts.id, artifact.id))
      .returning({
        id: artifacts.id,
        title: artifacts.title,
        description: artifacts.description,
        projectId: artifacts.projectId,
      });
    // A reference to a project deleted since reads as none, as it does everywhere else.
    let projectId = updated!.projectId;
    if (projectId && projectId !== edit.projectId) {
      const [live] = await tx
        .select({ id: researchProjects.id })
        .from(researchProjects)
        .where(and(eq(researchProjects.id, projectId), isNull(researchProjects.deletedAt)));
      if (!live) projectId = null;
    }
    if (changes.title !== undefined || changes.description !== undefined) {
      await indexArtifactMetadata(tx, artifact.id);
    }
    await recordAudit(tx, {
      action: "artifact.updated",
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      targetType: "artifact",
      targetId: artifact.id,
      metadata: { fields: Object.keys(changes) },
      ...meta,
    });
    return { ...updated!, projectId };
  });
}

// ---------- a version's source metadata ----------

export const SOURCE_PLATFORM_MAX = 100;
export const SOURCE_TEXT_MAX = 200;
export const SOURCE_URL_MAX = 2_048;

/**
 * Where a version came from, as the owner records it (FR-LIB-6): platform, model, research date,
 * author and source URL. Each field is optional; `null` (or empty) clears it.
 */
export interface VersionSourceEdit {
  sourcePlatform?: string | null;
  sourceModel?: string | null;
  researchDate?: string | null;
  author?: string | null;
  sourceUrl?: string | null;
}

const blank = (value: string | null | undefined) => value == null || value.trim() === "";

/** A real calendar day Postgres accepts, as `YYYY-MM-DD` (year 1 or later). */
function cleanDay(value: string): string {
  const day = value.trim();
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(`${day}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) {
    throw new AppError("VALIDATION_FAILED", "Research dates are real days, as YYYY-MM-DD");
  }
  if (day < "0001-01-01") throw new AppError("VALIDATION_FAILED", "Years start at 1");
  return day;
}

/** An http(s) link without credentials; shown as a link, so nothing else is accepted. */
function cleanSourceUrl(value: string): string {
  const href = value.trim().length <= SOURCE_URL_MAX ? linkableUrl(value) : null;
  if (!href || href.length > SOURCE_URL_MAX) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Source URLs are http(s) links without credentials, at most ${SOURCE_URL_MAX} characters`,
    );
  }
  return href;
}

/**
 * Edits a version's source metadata (never its file), re-indexing the artifact in the same
 * transaction: the current version's source fields are search metadata. Locks the version, then
 * its artifact, the order the search index job takes (`indexVersion`); the other order deadlocks
 * with a job for the same version. Out-of-workspace or deleted artifacts, and versions of
 * another artifact, are 404.
 */
export async function updateVersionSource(
  db: Database,
  actor: Actor,
  input: { artifactId: string; versionId: string },
  edit: VersionSourceEdit,
  meta: RequestMeta,
) {
  const changes: Partial<typeof artifactVersions.$inferInsert> = {};
  if (edit.sourcePlatform !== undefined)
    changes.sourcePlatform = blank(edit.sourcePlatform)
      ? null
      : cleanTitle(edit.sourcePlatform!, SOURCE_PLATFORM_MAX, "Platforms");
  if (edit.sourceModel !== undefined)
    changes.sourceModel = blank(edit.sourceModel)
      ? null
      : cleanTitle(edit.sourceModel!, SOURCE_TEXT_MAX, "Models");
  if (edit.author !== undefined)
    changes.author = blank(edit.author)
      ? null
      : cleanTitle(edit.author!, SOURCE_TEXT_MAX, "Authors");
  if (edit.researchDate !== undefined)
    changes.researchDate = blank(edit.researchDate) ? null : cleanDay(edit.researchDate!);
  if (edit.sourceUrl !== undefined)
    changes.sourceUrl = blank(edit.sourceUrl) ? null : cleanSourceUrl(edit.sourceUrl!);
  if (Object.keys(changes).length === 0) {
    throw new AppError("VALIDATION_FAILED", "Nothing to update");
  }
  if (!isUuid(input.artifactId) || !isUuid(input.versionId)) throw notFound("Version");
  return db.transaction(async (tx) => {
    const [version] = await tx
      .select({ id: artifactVersions.id, artifactId: artifactVersions.artifactId })
      .from(artifactVersions)
      .where(
        and(
          eq(artifactVersions.id, input.versionId),
          eq(artifactVersions.workspaceId, actor.workspaceId),
        ),
      )
      .for("update");
    if (!version || version.artifactId !== input.artifactId) throw notFound("Version");
    const [artifact] = await tx
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.id, version.artifactId),
          eq(artifacts.workspaceId, actor.workspaceId),
          isNull(artifacts.deletedAt),
        ),
      )
      .for("update");
    if (!artifact) throw notFound("Artifact");
    const [updated] = await tx
      .update(artifactVersions)
      .set(changes)
      .where(eq(artifactVersions.id, version.id))
      .returning({
        id: artifactVersions.id,
        sourcePlatform: artifactVersions.sourcePlatform,
        sourceModel: artifactVersions.sourceModel,
        researchDate: artifactVersions.researchDate,
        author: artifactVersions.author,
        sourceUrl: artifactVersions.sourceUrl,
      });
    if (!updated) throw notFound("Version");
    await indexArtifactMetadata(tx, artifact.id);
    await recordAudit(tx, {
      action: "artifact_version.updated",
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      targetType: "artifact_version",
      targetId: updated.id,
      metadata: { artifactId: artifact.id, fields: Object.keys(changes) },
      ...meta,
    });
    return updated;
  });
}
