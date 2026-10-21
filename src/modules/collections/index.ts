import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Database, DbExecutor } from "@/infrastructure/database/client";
import {
  artifacts,
  type COLLECTION_KINDS,
  COLLECTION_MAX_DEPTH,
  COLLECTION_NAME_MAX_LENGTH,
  collectionItems,
  collections,
} from "@/infrastructure/database/schema";
import { AppError, notFound } from "@/lib/errors";
import { cleanDescription, cleanTitle, identityOf } from "@/lib/text";
import { getArtifactForActor } from "@/modules/artifacts";
import { recordAudit, type RequestMeta } from "@/modules/audit";
import type { Actor } from "@/modules/auth";

/**
 * Collections (FR-LIB-5, DATA_MODEL §4.4, API_CONTRACT §6): a tree of categories and custom
 * collections per workspace; an artifact can be in many. Everything is scoped to the actor's
 * workspace; another workspace's collection or artifact is "not found".
 *
 * Changes to the tree's shape (create, move, delete) take a per-workspace transaction lock,
 * so two moves can never each pass the cycle check and together make a cycle. Audit events
 * carry ids only: names are user content.
 */

export type CollectionKind = (typeof COLLECTION_KINDS)[number];

export interface CollectionNode {
  id: string;
  parentId: string | null;
  kind: CollectionKind;
  name: string;
  description: string | null;
  /** Artifacts directly in the collection, not counting deleted ones. */
  artifactCount: number;
  /** 0 for a top-level collection. */
  depth: number;
}

const DESCRIPTION_MAX = 2_000;
/**
 * Bound on every walk up or down the tree. Code keeps the tree acyclic and at most
 * COLLECTION_MAX_DEPTH deep; the bound only stops a walk from running forever if a direct
 * database write ever broke that.
 */
const RECURSION_LIMIT = COLLECTION_MAX_DEPTH + 10;

export function normalizeCollectionName(input: string) {
  const name = cleanTitle(input, COLLECTION_NAME_MAX_LENGTH, "Collection names");
  return { name, normalizedName: identityOf(name) };
}

function pgCode(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

const siblingTaken = () =>
  new AppError("CONFLICT", "Another collection here already has this name");

/**
 * Serializes changes to the shape of one workspace's tree (create, move, delete; restore takes
 * it too).
 */
export async function lockCollectionTree(tx: DbExecutor, workspaceId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`collections:${workspaceId}`}))`);
}

/** Depth-first order (siblings by name), with each node's depth. */
export function orderTree<T extends { id: string; parentId: string | null; name: string }>(
  rows: T[],
): (T & { depth: number })[] {
  const children = new Map<string | null, T[]>();
  for (const row of rows) {
    const list = children.get(row.parentId) ?? [];
    list.push(row);
    children.set(row.parentId, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.name.localeCompare(b.name, "zh-TW"));
  const ordered: (T & { depth: number })[] = [];
  const visit = (parentId: string | null, depth: number) => {
    for (const row of children.get(parentId) ?? []) {
      ordered.push({ ...row, depth });
      visit(row.id, depth + 1);
    }
  };
  visit(null, 0);
  return ordered;
}

export async function listCollections(db: DbExecutor, actor: Actor): Promise<CollectionNode[]> {
  const rows = await db
    .select({
      id: collections.id,
      parentId: collections.parentId,
      kind: collections.kind,
      name: collections.name,
      description: collections.description,
      artifactCount: sql<number>`count(${artifacts.id})::int`,
    })
    .from(collections)
    .leftJoin(collectionItems, eq(collectionItems.collectionId, collections.id))
    .leftJoin(
      artifacts,
      and(eq(artifacts.id, collectionItems.artifactId), isNull(artifacts.deletedAt)),
    )
    .where(eq(collections.workspaceId, actor.workspaceId))
    .groupBy(collections.id);
  return orderTree(rows);
}

/** The collection if it belongs to the actor's workspace, else null. */
export async function findCollection(db: DbExecutor, actor: Actor, collectionId: string) {
  const [collection] = await db
    .select({ id: collections.id, name: collections.name, parentId: collections.parentId })
    .from(collections)
    .where(and(eq(collections.id, collectionId), eq(collections.workspaceId, actor.workspaceId)));
  return collection ?? null;
}

/** Levels above `collectionId` (0 for a top-level collection). */
export async function collectionDepth(tx: DbExecutor, collectionId: string): Promise<number> {
  const result = await tx.execute<{ depth: number }>(sql`
    with recursive up(id, parent_id, depth) as (
      select id, parent_id, 0 from collections where id = ${collectionId}
      union all
      select c.id, c.parent_id, up.depth + 1 from collections c join up on c.id = up.parent_id
      where up.depth < ${RECURSION_LIMIT}
    )
    select max(depth)::int as depth from up
  `);
  return result.rows[0]?.depth ?? 0;
}

/** The ids of a collection's subtree (itself included) and its height below it. */
async function subtreeOf(tx: DbExecutor, collectionId: string) {
  const result = await tx.execute<{ id: string; level: number }>(sql`
    with recursive down(id, level) as (
      select id, 0 from collections where id = ${collectionId}
      union all
      select c.id, down.level + 1 from collections c join down on c.parent_id = down.id
      where down.level < ${RECURSION_LIMIT}
    )
    select id, level from down
  `);
  return {
    ids: new Set(result.rows.map((row) => row.id)),
    height: Math.max(0, ...result.rows.map((row) => row.level)),
  };
}

async function requireParent(tx: DbExecutor, actor: Actor, parentId: string) {
  const [parent] = await tx
    .select({ id: collections.id })
    .from(collections)
    .where(and(eq(collections.id, parentId), eq(collections.workspaceId, actor.workspaceId)));
  if (!parent) throw notFound("Parent collection");
}

/** After the collection's last item (positions keep the order artifacts were added in). */
const nextPosition = (collectionId: string) =>
  sql`coalesce((select max(${collectionItems.position}) from ${collectionItems} where ${collectionItems.collectionId} = ${collectionId}), 0) + 1`;

function tooDeep(): AppError {
  return new AppError(
    "VALIDATION_FAILED",
    `Collections nest at most ${COLLECTION_MAX_DEPTH + 1} levels deep`,
  );
}

export async function createCollection(
  db: Database,
  actor: Actor,
  input: {
    name: string;
    parentId?: string | null;
    kind?: CollectionKind;
    description?: string | null;
  },
  meta: RequestMeta,
) {
  const { name, normalizedName } = normalizeCollectionName(input.name);
  const description = cleanDescription(input.description ?? null, DESCRIPTION_MAX);
  try {
    return await db.transaction(async (tx) => {
      await lockCollectionTree(tx, actor.workspaceId);
      if (input.parentId) {
        await requireParent(tx, actor, input.parentId);
        if ((await collectionDepth(tx, input.parentId)) + 1 > COLLECTION_MAX_DEPTH) throw tooDeep();
      }
      const [collection] = await tx
        .insert(collections)
        .values({
          workspaceId: actor.workspaceId,
          parentId: input.parentId ?? null,
          kind: input.kind ?? "collection",
          name,
          normalizedName,
          description,
        })
        .returning({
          id: collections.id,
          parentId: collections.parentId,
          kind: collections.kind,
          name: collections.name,
          description: collections.description,
        });
      await recordAudit(tx, {
        action: "collection.created",
        workspaceId: actor.workspaceId,
        actorUserId: actor.userId,
        targetType: "collection",
        targetId: collection!.id,
        ...meta,
      });
      return collection!;
    });
  } catch (error) {
    if (pgCode(error) === "23505") throw siblingTaken();
    throw error;
  }
}

/**
 * Renames, describes, re-kinds or moves a collection. `parentId: null` moves it to the top;
 * a move under itself or one of its descendants is refused, as is one that would nest the
 * tree too deep.
 */
export async function updateCollection(
  db: Database,
  actor: Actor,
  collectionId: string,
  input: {
    name?: string;
    description?: string | null;
    kind?: CollectionKind;
    parentId?: string | null;
  },
  meta: RequestMeta,
) {
  const changes: Partial<typeof collections.$inferInsert> = {};
  if (input.name !== undefined) Object.assign(changes, normalizeCollectionName(input.name));
  if (input.description !== undefined)
    changes.description = cleanDescription(input.description, DESCRIPTION_MAX);
  if (input.kind !== undefined) changes.kind = input.kind;
  if (input.parentId !== undefined) changes.parentId = input.parentId;
  if (Object.keys(changes).length === 0) {
    throw new AppError("VALIDATION_FAILED", "Nothing to update");
  }
  try {
    return await db.transaction(async (tx) => {
      if (input.parentId !== undefined) await lockCollectionTree(tx, actor.workspaceId);
      const [current] = await tx
        .select({ id: collections.id })
        .from(collections)
        .where(
          and(eq(collections.id, collectionId), eq(collections.workspaceId, actor.workspaceId)),
        )
        .for("update");
      if (!current) throw notFound("Collection");
      if (input.parentId) {
        await requireParent(tx, actor, input.parentId);
        const subtree = await subtreeOf(tx, current.id);
        if (subtree.ids.has(input.parentId)) {
          throw new AppError(
            "VALIDATION_FAILED",
            "A collection cannot move into itself or one of its own subcollections",
          );
        }
        if (
          (await collectionDepth(tx, input.parentId)) + 1 + subtree.height >
          COLLECTION_MAX_DEPTH
        ) {
          throw tooDeep();
        }
      }
      const [collection] = await tx
        .update(collections)
        .set(changes)
        .where(eq(collections.id, current.id))
        .returning({
          id: collections.id,
          parentId: collections.parentId,
          kind: collections.kind,
          name: collections.name,
          description: collections.description,
        });
      await recordAudit(tx, {
        action: "collection.updated",
        workspaceId: actor.workspaceId,
        actorUserId: actor.userId,
        targetType: "collection",
        targetId: current.id,
        metadata: { fields: Object.keys(changes).filter((field) => field !== "normalizedName") },
        ...meta,
      });
      return collection!;
    });
  } catch (error) {
    if (pgCode(error) === "23505") throw siblingTaken();
    throw error;
  }
}

/**
 * Deletes a collection that has no subcollections (move or delete those first). Its
 * artifacts are not touched; they only leave the collection.
 */
export async function deleteCollection(
  db: Database,
  actor: Actor,
  collectionId: string,
  meta: RequestMeta,
) {
  await db.transaction(async (tx) => {
    await lockCollectionTree(tx, actor.workspaceId);
    const [current] = await tx
      .select({ id: collections.id })
      .from(collections)
      .where(and(eq(collections.id, collectionId), eq(collections.workspaceId, actor.workspaceId)))
      .for("update");
    if (!current) throw notFound("Collection");
    const [child] = await tx
      .select({ id: collections.id })
      .from(collections)
      .where(eq(collections.parentId, current.id))
      .limit(1);
    if (child) {
      throw new AppError("CONFLICT", "Move or delete this collection's subcollections first", {
        details: { reason: "HAS_CHILDREN" },
      });
    }
    await tx.delete(collections).where(eq(collections.id, current.id));
    await recordAudit(tx, {
      action: "collection.deleted",
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      targetType: "collection",
      targetId: current.id,
      ...meta,
    });
  });
}

export interface ArtifactCollection {
  id: string;
  name: string;
  /** Names from the top of the tree down to this collection. */
  path: string[];
}

/** The collections an artifact (already checked to be the actor's) is in, with their paths. */
export async function collectionsOf(db: DbExecutor, workspaceId: string, artifactId: string) {
  const result = await db.execute<{ id: string; name: string; path: string[] }>(sql`
    with recursive up(start_id, id, parent_id, name, depth) as (
      select c.id, c.id, c.parent_id, c.name, 0
      from collection_items ci join collections c on c.id = ci.collection_id
      where ci.artifact_id = ${artifactId} and ci.workspace_id = ${workspaceId}
      union all
      select up.start_id, p.id, p.parent_id, p.name, up.depth + 1
      from collections p join up on p.id = up.parent_id
      where up.depth < ${RECURSION_LIMIT}
    )
    select start_id as id,
      (array_agg(name order by depth) filter (where depth = 0))[1] as name,
      array_agg(name order by depth desc) as path
    from up
    group by start_id
  `);
  return result.rows
    .map((row) => ({ id: row.id, name: row.name, path: row.path }))
    .sort((a, b) => a.path.join("/").localeCompare(b.path.join("/"), "zh-TW"));
}

export async function getArtifactCollections(
  db: DbExecutor,
  actor: Actor,
  artifactId: string,
): Promise<ArtifactCollection[]> {
  await getArtifactForActor(db, actor, artifactId);
  return collectionsOf(db, actor.workspaceId, artifactId);
}

/**
 * Puts an artifact in a collection (`present`) or takes it out. Both must be the actor's and
 * the artifact not deleted. Idempotent. Returns the artifact's collections afterwards.
 */
export async function setCollectionItem(
  db: Database,
  actor: Actor,
  input: { collectionId: string; artifactId: string; present: boolean },
  meta: RequestMeta,
): Promise<ArtifactCollection[]> {
  return db.transaction(async (tx) => {
    const artifact = await getArtifactForActor(tx, actor, input.artifactId);
    // Shared lock: a concurrent delete of the collection waits for this transaction.
    const [collection] = await tx
      .select({ id: collections.id })
      .from(collections)
      .where(
        and(eq(collections.id, input.collectionId), eq(collections.workspaceId, actor.workspaceId)),
      )
      .for("share");
    if (!collection) throw notFound("Collection");
    const changed = input.present
      ? await tx
          .insert(collectionItems)
          .values({
            workspaceId: actor.workspaceId,
            collectionId: collection.id,
            artifactId: artifact.id,
            position: nextPosition(collection.id),
          })
          .onConflictDoNothing()
          .returning({ collectionId: collectionItems.collectionId })
      : await tx
          .delete(collectionItems)
          .where(
            and(
              eq(collectionItems.collectionId, collection.id),
              eq(collectionItems.artifactId, artifact.id),
            ),
          )
          .returning({ collectionId: collectionItems.collectionId });
    if (changed.length > 0) {
      await recordAudit(tx, {
        action: input.present ? "artifact.collection_added" : "artifact.collection_removed",
        workspaceId: actor.workspaceId,
        actorUserId: actor.userId,
        targetType: "artifact",
        targetId: artifact.id,
        metadata: { collectionId: collection.id },
        ...meta,
      });
    }
    return collectionsOf(tx, actor.workspaceId, artifact.id);
  });
}

/**
 * Adds a just-imported artifact to its batch's collection, inside the import transaction. The
 * collection may have been deleted since the batch was created (the batch's reference is then
 * cleared, or the row is gone): the artifact is simply not added. The key-share lock keeps the
 * collection from being deleted before this transaction commits.
 */
export async function addImportedArtifact(
  tx: DbExecutor,
  workspaceId: string,
  collectionId: string,
  artifactId: string,
) {
  const [collection] = await tx
    .select({ id: collections.id })
    .from(collections)
    .where(and(eq(collections.id, collectionId), eq(collections.workspaceId, workspaceId)))
    .for("key share");
  if (!collection) return;
  await tx
    .insert(collectionItems)
    .values({
      workspaceId,
      collectionId: collection.id,
      artifactId,
      position: nextPosition(collection.id),
    })
    .onConflictDoNothing();
}

/** Collections ordered for pickers: depth-first, each with its indent level. */
export async function collectionOptions(db: DbExecutor, actor: Actor) {
  const rows = await db
    .select({ id: collections.id, parentId: collections.parentId, name: collections.name })
    .from(collections)
    .where(eq(collections.workspaceId, actor.workspaceId))
    .orderBy(asc(collections.name));
  return orderTree(rows);
}
