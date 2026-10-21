import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Database, DbExecutor } from "@/infrastructure/database/client";
import {
  artifacts,
  artifactTags,
  TAG_NAME_MAX_LENGTH,
  tags,
} from "@/infrastructure/database/schema";
import { AppError, notFound } from "@/lib/errors";
import { getArtifactForActor, type TagSummary } from "@/modules/artifacts";
import { recordAudit, type RequestMeta } from "@/modules/audit";
import type { Actor } from "@/modules/auth";
import { indexArtifactMetadata } from "@/modules/search";

export { tagsByArtifact, type TagSummary } from "@/modules/artifacts";

/**
 * Tags (docs/DATA_MODEL.md §4.4, API_CONTRACT §6). Every read and write is scoped to the
 * actor's workspace; a tag or artifact outside it is "not found". Tag names are part of the
 * artifact's search metadata (weight B), so every change re-indexes the artifacts it touches
 * in the same transaction: search never shows a renamed, merged or removed tag.
 *
 * Audit events carry ids only: tag names are user content.
 */

export interface TagWithCount extends TagSummary {
  /** Artifacts carrying the tag, not counting deleted ones. */
  artifactCount: number;
}

/** Characters that render as nothing; dropped so they can't make two names look alike. */
const INVISIBLE = /[\u200b\u2060\ufeff]/gu;
/** Bidirectional controls: they can make a name display as something else (e.g. an RLO turning `abc\u202eexe.gpj` into `abcjpg.exe`). */
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
/** Hangul fillers are letters (Lo) that render blank. */
const FILLERS = /[\u115f\u1160\u3164\uffa0]/gu;
/** A name must have at least one character that shows: a letter, digit, punctuation or symbol. */
const VISIBLE = /[\p{L}\p{N}\p{P}\p{S}]/u;

/**
 * The display name (NFC, single spaces, trimmed) and the identity of a tag name: NFKC,
 * lower-case, collapsed whitespace. `ＡＩ` and `ai` are one tag. Names that would render as
 * nothing, or could display as something else, are refused.
 */
export function normalizeTagName(input: string): { name: string; normalizedName: string } {
  const name = input.normalize("NFC").replace(INVISIBLE, "").replace(/\s+/gu, " ").trim();
  if (
    !name ||
    /[\p{Cc}\p{Cs}]/u.test(name) ||
    BIDI_CONTROLS.test(name) ||
    !VISIBLE.test(name.replace(FILLERS, ""))
  ) {
    throw new AppError("VALIDATION_FAILED", "Tag names must be visible text");
  }
  if (Array.from(name).length > TAG_NAME_MAX_LENGTH) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Tag names are at most ${TAG_NAME_MAX_LENGTH} characters`,
    );
  }
  const normalizedName = name.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
  return { name, normalizedName };
}

/** The Postgres error code under Drizzle's wrapper, if any. */
function pgCode(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function nameTaken(otherTagId?: string): AppError {
  return new AppError("CONFLICT", "Another tag already has this name; merge the tags instead", {
    details: otherTagId ? { tagId: otherTagId } : undefined,
  });
}

export async function listTags(db: DbExecutor, actor: Actor): Promise<TagWithCount[]> {
  return db
    .select({
      id: tags.id,
      name: tags.name,
      artifactCount: sql<number>`count(${artifacts.id})::int`,
    })
    .from(tags)
    .leftJoin(artifactTags, eq(artifactTags.tagId, tags.id))
    .leftJoin(
      artifacts,
      and(eq(artifacts.id, artifactTags.artifactId), isNull(artifacts.deletedAt)),
    )
    .where(eq(tags.workspaceId, actor.workspaceId))
    .groupBy(tags.id)
    .orderBy(asc(tags.normalizedName));
}

/** The tag if it belongs to the actor's workspace, else null. */
export async function findTag(
  db: DbExecutor,
  actor: Actor,
  tagId: string,
): Promise<TagSummary | null> {
  const [tag] = await db
    .select({ id: tags.id, name: tags.name })
    .from(tags)
    .where(and(eq(tags.id, tagId), eq(tags.workspaceId, actor.workspaceId)));
  return tag ?? null;
}

/** Locks a tag of the actor's workspace for the rest of the transaction, or 404. */
async function lockTag(tx: DbExecutor, actor: Actor, tagId: string) {
  const [tag] = await tx
    .select({ id: tags.id, name: tags.name, normalizedName: tags.normalizedName })
    .from(tags)
    .where(and(eq(tags.id, tagId), eq(tags.workspaceId, actor.workspaceId)))
    .for("update");
  if (!tag) throw notFound("Tag");
  return tag;
}

async function taggedArtifactIds(tx: DbExecutor, tagId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: artifactTags.artifactId })
    .from(artifactTags)
    .where(eq(artifactTags.tagId, tagId));
  return rows.map((row) => row.id);
}

/**
 * Locks artifact rows for update, sorted by id. Every tag operation locks the artifacts it
 * touches *before* writing `artifact_tags`: a link's foreign key takes a key-share lock on the
 * artifact, and two transactions that each held one while waiting to lock the artifact for its
 * metadata document would deadlock. Lock order everywhere: tag rows, then artifact rows.
 */
async function lockArtifacts(tx: DbExecutor, artifactIds: Iterable<string>) {
  for (const id of [...new Set(artifactIds)].sort()) {
    await tx.select({ id: artifacts.id }).from(artifacts).where(eq(artifacts.id, id)).for("update");
  }
}

/** Rebuilds the metadata documents of the given artifacts, in the same sorted order. */
async function reindex(tx: DbExecutor, artifactIds: Iterable<string>) {
  for (const id of [...new Set(artifactIds)].sort()) await indexArtifactMetadata(tx, id);
}

/**
 * Returns the workspace's tag with this name, creating it if needed (`created` says which).
 * Names that differ only in case, width or spacing are the same tag.
 */
export async function ensureTag(
  db: Database,
  actor: Actor,
  rawName: string,
  meta: RequestMeta,
): Promise<{ tag: TagSummary; created: boolean }> {
  const { name, normalizedName } = normalizeTagName(rawName);
  // The conflicting tag can be renamed or deleted between the insert and the select (each
  // statement sees its own snapshot), so try again a few times rather than return nothing.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(tags)
        .values({ workspaceId: actor.workspaceId, name, normalizedName })
        .onConflictDoNothing({ target: [tags.workspaceId, tags.normalizedName] })
        .returning({ id: tags.id, name: tags.name });
      if (inserted) {
        await recordAudit(tx, {
          action: "tag.created",
          workspaceId: actor.workspaceId,
          actorUserId: actor.userId,
          targetType: "tag",
          targetId: inserted.id,
          ...meta,
        });
        return { tag: inserted, created: true };
      }
      const [existing] = await tx
        .select({ id: tags.id, name: tags.name })
        .from(tags)
        .where(
          and(eq(tags.workspaceId, actor.workspaceId), eq(tags.normalizedName, normalizedName)),
        );
      return existing ? { tag: existing, created: false } : null;
    });
    if (result) return result;
  }
  throw new AppError("CONFLICT", "The tag changed while it was being saved; try again", {
    retryable: true,
  });
}

/** Renames a tag. A name another tag already has is a 409: merging is a separate decision. */
export async function renameTag(
  db: Database,
  actor: Actor,
  tagId: string,
  rawName: string,
  meta: RequestMeta,
): Promise<TagSummary> {
  const { name, normalizedName } = normalizeTagName(rawName);
  try {
    return await db.transaction(async (tx) => {
      const tag = await lockTag(tx, actor, tagId);
      if (tag.name === name) return { id: tag.id, name: tag.name };
      if (tag.normalizedName !== normalizedName) {
        const [other] = await tx
          .select({ id: tags.id })
          .from(tags)
          .where(
            and(eq(tags.workspaceId, actor.workspaceId), eq(tags.normalizedName, normalizedName)),
          );
        if (other) throw nameTaken(other.id);
      }
      await tx.update(tags).set({ name, normalizedName }).where(eq(tags.id, tag.id));
      await reindex(tx, await taggedArtifactIds(tx, tag.id));
      await recordAudit(tx, {
        action: "tag.renamed",
        workspaceId: actor.workspaceId,
        actorUserId: actor.userId,
        targetType: "tag",
        targetId: tag.id,
        ...meta,
      });
      return { id: tag.id, name };
    });
  } catch (error) {
    // Two renames racing to the same new name: the unique constraint decides.
    if (pgCode(error) === "23505") throw nameTaken();
    throw error;
  }
}

/** Deletes a tag and removes it from every artifact. */
export async function deleteTag(db: Database, actor: Actor, tagId: string, meta: RequestMeta) {
  await db.transaction(async (tx) => {
    const tag = await lockTag(tx, actor, tagId);
    const affected = await taggedArtifactIds(tx, tag.id);
    await tx.delete(tags).where(eq(tags.id, tag.id));
    await reindex(tx, affected);
    await recordAudit(tx, {
      action: "tag.deleted",
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      targetType: "tag",
      targetId: tag.id,
      metadata: { artifactCount: affected.length },
      ...meta,
    });
  });
}

/**
 * Merges `sourceId` into `intoId`: every artifact tagged with the source gets the target tag,
 * then the source tag is deleted. Returns the target tag.
 */
export async function mergeTag(
  db: Database,
  actor: Actor,
  sourceId: string,
  intoId: string,
  meta: RequestMeta,
): Promise<TagSummary> {
  if (sourceId === intoId) {
    throw new AppError("VALIDATION_FAILED", "A tag cannot be merged into itself");
  }
  return db.transaction(async (tx) => {
    // Both rows locked in id order: two merges of the same pair cannot deadlock.
    const locked = new Map<string, Awaited<ReturnType<typeof lockTag>>>();
    for (const id of [sourceId, intoId].sort()) locked.set(id, await lockTag(tx, actor, id));
    const into = locked.get(intoId)!;
    const affected = await taggedArtifactIds(tx, sourceId);
    await lockArtifacts(tx, affected);
    if (affected.length > 0) {
      await tx
        .insert(artifactTags)
        .values(
          affected.map((artifactId) => ({
            workspaceId: actor.workspaceId,
            artifactId,
            tagId: into.id,
          })),
        )
        .onConflictDoNothing();
    }
    await tx.delete(tags).where(eq(tags.id, sourceId));
    await reindex(tx, affected);
    await recordAudit(tx, {
      action: "tag.merged",
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      targetType: "tag",
      targetId: sourceId,
      metadata: { intoTagId: into.id, artifactCount: affected.length },
      ...meta,
    });
    return { id: into.id, name: into.name };
  });
}

/** The tags of one artifact (already checked to be the actor's), by name. */
async function tagsOf(db: DbExecutor, artifactId: string): Promise<TagSummary[]> {
  return db
    .select({ id: tags.id, name: tags.name })
    .from(artifactTags)
    .innerJoin(tags, eq(tags.id, artifactTags.tagId))
    .where(eq(artifactTags.artifactId, artifactId))
    .orderBy(asc(tags.normalizedName));
}

export async function getArtifactTags(
  db: DbExecutor,
  actor: Actor,
  artifactId: string,
): Promise<TagSummary[]> {
  await getArtifactForActor(db, actor, artifactId);
  return tagsOf(db, artifactId);
}

/**
 * Adds (`present`) or removes a tag on an artifact; both must be the actor's, and the artifact
 * not deleted. Idempotent. Returns the artifact's tags afterwards.
 */
export async function setArtifactTag(
  db: Database,
  actor: Actor,
  input: { artifactId: string; tagId: string; present: boolean },
  meta: RequestMeta,
): Promise<TagSummary[]> {
  return db.transaction(async (tx) => {
    const artifact = await getArtifactForActor(tx, actor, input.artifactId);
    // Shared lock: a concurrent delete or merge of this tag waits for this transaction.
    const [tag] = await tx
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.id, input.tagId), eq(tags.workspaceId, actor.workspaceId)))
      .for("share");
    if (!tag) throw notFound("Tag");
    await lockArtifacts(tx, [artifact.id]);
    const changed = input.present
      ? await tx
          .insert(artifactTags)
          .values({ workspaceId: actor.workspaceId, artifactId: artifact.id, tagId: tag.id })
          .onConflictDoNothing()
          .returning({ tagId: artifactTags.tagId })
      : await tx
          .delete(artifactTags)
          .where(and(eq(artifactTags.artifactId, artifact.id), eq(artifactTags.tagId, tag.id)))
          .returning({ tagId: artifactTags.tagId });
    if (changed.length > 0) {
      await indexArtifactMetadata(tx, artifact.id);
      await recordAudit(tx, {
        action: input.present ? "artifact.tag_added" : "artifact.tag_removed",
        workspaceId: actor.workspaceId,
        actorUserId: actor.userId,
        targetType: "artifact",
        targetId: artifact.id,
        metadata: { tagId: tag.id },
        ...meta,
      });
    }
    return tagsOf(tx, artifact.id);
  });
}
