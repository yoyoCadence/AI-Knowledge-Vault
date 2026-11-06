import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import type { Database, DbExecutor } from "@/infrastructure/database/client";
import { beforeCursor, cursorTimestamp } from "@/infrastructure/database/keyset";
import { artifacts, artifactVersions } from "@/infrastructure/database/schema";
import type { KeysetCursor } from "@/lib/cursor";
import { notFound } from "@/lib/errors";
import { isUuid } from "@/lib/ids";
import { recordAudit, type RequestMeta } from "@/modules/audit";
import type { Actor } from "@/modules/auth";

/**
 * Soft delete and undo (ADR-017, API_CONTRACT §5). Deleting sets `deleted_at` and nothing else:
 * originals, versions, extractions, derived files, tags, collections, notes, reading states,
 * search chunks and share links all stay, and every reader already skips a deleted artifact
 * (library, search, detail, previews, thumbnails, share links, counts, import matching). So
 * restoring brings back exactly what was there, share links included; while deleted, nobody
 * can open it, a link holder included. Purging (removing data for good) is a later task.
 *
 * Each change is one conditional UPDATE: deleting a deleted artifact, or restoring a live one,
 * matches no row and is 404, the same answer as another workspace's id, so a repeated click or
 * a race between two tabs changes nothing twice. The UPDATE takes the row lock that link
 * changes (tags, collections, shares) take before re-checking `deleted_at`, so a change that
 * commits first wins and the other then sees it.
 */

export interface DeletedArtifact {
  id: string;
  title: string;
  deletedAt: Date;
  contentKind: string | null;
}

export async function deleteArtifact(
  db: Database,
  actor: Actor,
  artifactId: string,
  meta: RequestMeta,
): Promise<{ id: string; title: string; deletedAt: Date }> {
  if (!isUuid(artifactId)) throw notFound("Artifact");
  return db.transaction(async (tx) => {
    const [deleted] = await tx
      .update(artifacts)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(artifacts.id, artifactId),
          eq(artifacts.workspaceId, actor.workspaceId),
          isNull(artifacts.deletedAt),
        ),
      )
      .returning({ id: artifacts.id, title: artifacts.title, deletedAt: artifacts.deletedAt });
    if (!deleted) throw notFound("Artifact");
    await recordAudit(tx, {
      action: "artifact.deleted",
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      targetType: "artifact",
      targetId: deleted.id,
      ...meta,
    });
    return { id: deleted.id, title: deleted.title, deletedAt: deleted.deletedAt! };
  });
}

/** Undoes `deleteArtifact`. A live artifact, or one outside the workspace, is 404. */
export async function restoreDeletedArtifact(
  db: Database,
  actor: Actor,
  artifactId: string,
  meta: RequestMeta,
): Promise<{ id: string; title: string }> {
  if (!isUuid(artifactId)) throw notFound("Deleted artifact");
  return db.transaction(async (tx) => {
    const [restored] = await tx
      .update(artifacts)
      .set({ deletedAt: null })
      .where(
        and(
          eq(artifacts.id, artifactId),
          eq(artifacts.workspaceId, actor.workspaceId),
          isNotNull(artifacts.deletedAt),
        ),
      )
      .returning({ id: artifacts.id, title: artifacts.title });
    if (!restored) throw notFound("Deleted artifact");
    await recordAudit(tx, {
      action: "artifact.restored",
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      targetType: "artifact",
      targetId: restored.id,
      ...meta,
    });
    return restored;
  });
}

/** One deleted artifact of the workspace (for the "deleted" notice), or null. */
export async function findDeletedArtifact(
  db: DbExecutor,
  actor: Actor,
  artifactId: string,
): Promise<{ id: string; title: string } | null> {
  if (!isUuid(artifactId)) return null;
  const [row] = await db
    .select({ id: artifacts.id, title: artifacts.title })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.id, artifactId),
        eq(artifacts.workspaceId, actor.workspaceId),
        isNotNull(artifacts.deletedAt),
      ),
    );
  return row ?? null;
}

/** The workspace's deleted artifacts, most recently deleted first, with keyset paging. */
export async function listDeletedArtifacts(
  db: DbExecutor,
  actor: Actor,
  options: { limit: number; cursor?: KeysetCursor },
): Promise<{ items: DeletedArtifact[]; nextCursor: KeysetCursor | null }> {
  const rows = await db
    .select({
      id: artifacts.id,
      title: artifacts.title,
      deletedAt: artifacts.deletedAt,
      cursorDeletedAt: cursorTimestamp(artifacts.deletedAt),
      contentKind: artifactVersions.contentKind,
    })
    .from(artifacts)
    .leftJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
    .where(
      and(
        eq(artifacts.workspaceId, actor.workspaceId),
        isNotNull(artifacts.deletedAt),
        beforeCursor(artifacts.deletedAt, artifacts.id, options.cursor),
      ),
    )
    .orderBy(desc(artifacts.deletedAt), desc(artifacts.id))
    .limit(options.limit + 1);
  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => ({
      id: row.id,
      title: row.title,
      deletedAt: row.deletedAt!,
      contentKind: row.contentKind,
    })),
    nextCursor:
      rows.length > options.limit && last ? { createdAt: last.cursorDeletedAt, id: last.id } : null,
  };
}
