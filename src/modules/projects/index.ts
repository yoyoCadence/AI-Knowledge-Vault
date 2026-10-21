import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Database, DbExecutor } from "@/infrastructure/database/client";
import {
  artifacts,
  type PROJECT_STATUSES,
  researchProjects,
} from "@/infrastructure/database/schema";
import { AppError, notFound } from "@/lib/errors";
import { cleanDescription, cleanTitle } from "@/lib/text";
import { recordAudit, type RequestMeta } from "@/modules/audit";
import type { Actor } from "@/modules/auth";

/**
 * Research projects (DATA_MODEL §4.2, API_CONTRACT §6): a workspace's way to group artifacts
 * by line of research. Every read and write is scoped to the actor's workspace; another
 * workspace's project is "not found". Deleting is soft (`deleted_at`, as for artifacts): the
 * project disappears from lists, filters and pickers, and artifacts keep their reference, so
 * nothing is lost and an undo stays possible. Audit events carry ids only.
 */

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export interface ProjectSummary {
  id: string;
  title: string;
  description: string | null;
  status: ProjectStatus;
  /** Artifacts in the project, not counting deleted ones. */
  artifactCount: number;
  createdAt: Date;
}

export const PROJECT_TITLE_MAX = 200;
export const PROJECT_DESCRIPTION_MAX = 2_000;

/** Trimmed, NFC, single-line title of 1–200 visible characters. */
export function normalizeProjectTitle(input: string): string {
  return cleanTitle(input, PROJECT_TITLE_MAX, "Project titles");
}

function normalizeDescription(input: string | null | undefined): string | null {
  return cleanDescription(input ?? null, PROJECT_DESCRIPTION_MAX, "Project descriptions");
}

export async function listProjects(db: DbExecutor, actor: Actor): Promise<ProjectSummary[]> {
  // `artifacts.project_id` references the project id alone, so the join matches the workspace
  // too: a reference that crosses workspaces (only possible by writing to the database
  // directly) must not leak into another workspace's count.
  return db
    .select({
      id: researchProjects.id,
      title: researchProjects.title,
      description: researchProjects.description,
      status: researchProjects.status,
      artifactCount: sql<number>`count(${artifacts.id})::int`,
      createdAt: researchProjects.createdAt,
    })
    .from(researchProjects)
    .leftJoin(
      artifacts,
      and(
        eq(artifacts.projectId, researchProjects.id),
        eq(artifacts.workspaceId, researchProjects.workspaceId),
        isNull(artifacts.deletedAt),
      ),
    )
    .where(
      and(eq(researchProjects.workspaceId, actor.workspaceId), isNull(researchProjects.deletedAt)),
    )
    .groupBy(researchProjects.id)
    .orderBy(asc(researchProjects.status), asc(researchProjects.title), asc(researchProjects.id));
}

/** The project if it belongs to the actor's workspace and is not deleted, else null. */
export async function findProject(db: DbExecutor, actor: Actor, projectId: string) {
  const [project] = await db
    .select({
      id: researchProjects.id,
      title: researchProjects.title,
      status: researchProjects.status,
    })
    .from(researchProjects)
    .where(
      and(
        eq(researchProjects.id, projectId),
        eq(researchProjects.workspaceId, actor.workspaceId),
        isNull(researchProjects.deletedAt),
      ),
    );
  return project ?? null;
}

export async function createProject(
  db: Database,
  actor: Actor,
  input: { title: string; description?: string | null },
  meta: RequestMeta,
) {
  const title = normalizeProjectTitle(input.title);
  const description = normalizeDescription(input.description);
  return db.transaction(async (tx) => {
    const [project] = await tx
      .insert(researchProjects)
      .values({ workspaceId: actor.workspaceId, title, description, createdBy: actor.userId })
      .returning({
        id: researchProjects.id,
        title: researchProjects.title,
        description: researchProjects.description,
        status: researchProjects.status,
      });
    await recordAudit(tx, {
      action: "project.created",
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      targetType: "research_project",
      targetId: project!.id,
      ...meta,
    });
    return project!;
  });
}

export async function updateProject(
  db: Database,
  actor: Actor,
  projectId: string,
  input: { title?: string; description?: string | null; status?: ProjectStatus },
  meta: RequestMeta,
) {
  const changes: Partial<typeof researchProjects.$inferInsert> = {};
  if (input.title !== undefined) changes.title = normalizeProjectTitle(input.title);
  if (input.description !== undefined)
    changes.description = normalizeDescription(input.description);
  if (input.status !== undefined) changes.status = input.status;
  if (Object.keys(changes).length === 0) {
    throw new AppError("VALIDATION_FAILED", "Nothing to update");
  }
  return db.transaction(async (tx) => {
    const [project] = await tx
      .update(researchProjects)
      .set(changes)
      .where(
        and(
          eq(researchProjects.id, projectId),
          eq(researchProjects.workspaceId, actor.workspaceId),
          isNull(researchProjects.deletedAt),
        ),
      )
      .returning({
        id: researchProjects.id,
        title: researchProjects.title,
        description: researchProjects.description,
        status: researchProjects.status,
      });
    if (!project) throw notFound("Research project");
    await recordAudit(tx, {
      action: "project.updated",
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      targetType: "research_project",
      targetId: project.id,
      metadata: { fields: Object.keys(changes) },
      ...meta,
    });
    return project;
  });
}

/**
 * Soft-deletes a project. Its artifacts keep `project_id`, so restoring the project (or an
 * export of it) brings the grouping back; until then they show no project.
 */
export async function deleteProject(
  db: Database,
  actor: Actor,
  projectId: string,
  meta: RequestMeta,
) {
  await db.transaction(async (tx) => {
    const [project] = await tx
      .update(researchProjects)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(researchProjects.id, projectId),
          eq(researchProjects.workspaceId, actor.workspaceId),
          isNull(researchProjects.deletedAt),
        ),
      )
      .returning({ id: researchProjects.id });
    if (!project) throw notFound("Research project");
    await recordAudit(tx, {
      action: "project.deleted",
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      targetType: "research_project",
      targetId: project.id,
      ...meta,
    });
  });
}
