import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "@/infrastructure/database/client";
import { artifacts, researchProjects } from "@/infrastructure/database/schema";
import { AppError, notFound } from "@/lib/errors";
import { cleanDescription, cleanTitle } from "@/lib/text";
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
