import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Database, DbExecutor } from "@/infrastructure/database/client";
import {
  artifactNotes,
  artifactReadingStates,
  artifacts,
  NOTE_MAX_LENGTH,
  type ReadingStatus,
  users,
} from "@/infrastructure/database/schema";
import { AppError, notFound } from "@/lib/errors";
import { markdownProblem } from "@/lib/markdown";
import { cleanDescription } from "@/lib/text";
import { getArtifactForActor } from "@/modules/artifacts";
import { recordAudit, type RequestMeta } from "@/modules/audit";
import type { Actor } from "@/modules/auth";
import { indexArtifactMetadata } from "@/modules/search";

/**
 * Notes and reading state (FR-LIB-8, DATA_MODEL §4.4, API_CONTRACT §6).
 *
 * Notes are Markdown written by workspace members, shown with the reading mode's allow-list
 * renderer (never as HTML) and part of the artifact's search metadata. Every note write locks
 * the artifact first (`FOR UPDATE`, re-checking it is not deleted), then writes the note and
 * re-indexes the artifact in the same transaction: the note's foreign key alone would take a
 * key-share lock that the re-index then has to upgrade, and two such writes on one artifact
 * would deadlock. Audit events carry ids only: note bodies are user content.
 *
 * Reading state is per user: unread, reading or read, a favorite flag, and when the user last
 * opened the artifact. It is personal, so it is not audited.
 */

export interface Note {
  id: string;
  bodyMarkdown: string;
  authorName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReadingState {
  status: ReadingStatus;
  isFavorite: boolean;
  lastOpenedAt: Date | null;
}

export const UNREAD: ReadingState = { status: "unread", isFavorite: false, lastOpenedAt: null };

/** Notes per artifact: bounds the artifact page, its search document and a restore's insert. */
export const NOTES_PER_ARTIFACT_MAX = 200;

/**
 * Note text: up to 20,000 characters, at least one non-blank (see `cleanDescription`), and
 * Markdown that can be shown without costing the server far more than its size
 * (`markdownProblem`: deep nesting, long runs of emphasis marks).
 */
export function normalizeNoteBody(input: string): string {
  const body = cleanDescription(input, NOTE_MAX_LENGTH, "Notes");
  if (!body) throw new AppError("VALIDATION_FAILED", "Notes must not be empty");
  const problem = markdownProblem(body);
  if (problem) throw new AppError("VALIDATION_FAILED", `This note's Markdown is ${problem}`);
  return body;
}

/** Locks a live artifact of the actor's workspace for a note write, or throws NOT_FOUND. */
async function lockArtifact(tx: DbExecutor, actor: Actor, artifactId: string) {
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
  return artifact;
}

const noteColumns = {
  id: artifactNotes.id,
  bodyMarkdown: artifactNotes.bodyMarkdown,
  authorName: users.name,
  createdAt: artifactNotes.createdAt,
  updatedAt: artifactNotes.updatedAt,
};

/** The notes of an artifact the actor may see, newest first. */
export async function listNotes(db: DbExecutor, actor: Actor, artifactId: string): Promise<Note[]> {
  await getArtifactForActor(db, actor, artifactId);
  return db
    .select(noteColumns)
    .from(artifactNotes)
    .leftJoin(users, eq(users.id, artifactNotes.authorId))
    .where(
      and(
        eq(artifactNotes.artifactId, artifactId),
        eq(artifactNotes.workspaceId, actor.workspaceId),
      ),
    )
    .orderBy(desc(artifactNotes.createdAt), desc(artifactNotes.id));
}

async function noteById(tx: DbExecutor, noteId: string) {
  const [note] = await tx
    .select(noteColumns)
    .from(artifactNotes)
    .leftJoin(users, eq(users.id, artifactNotes.authorId))
    .where(eq(artifactNotes.id, noteId));
  return note!;
}

export async function createNote(
  db: Database,
  actor: Actor,
  artifactId: string,
  body: string,
  meta: RequestMeta,
): Promise<Note> {
  const bodyMarkdown = normalizeNoteBody(body);
  return db.transaction(async (tx) => {
    const artifact = await lockArtifact(tx, actor, artifactId);
    // Counted under the artifact lock, so concurrent writes cannot pass the limit together.
    const [{ notes } = { notes: 0 }] = await tx
      .select({ notes: sql<number>`count(*)::int` })
      .from(artifactNotes)
      .where(eq(artifactNotes.artifactId, artifact.id));
    if (notes >= NOTES_PER_ARTIFACT_MAX) {
      throw new AppError("CONFLICT", `An artifact has at most ${NOTES_PER_ARTIFACT_MAX} notes`, {
        details: { reason: "TOO_MANY_NOTES" },
      });
    }
    const [note] = await tx
      .insert(artifactNotes)
      .values({
        workspaceId: actor.workspaceId,
        artifactId: artifact.id,
        authorId: actor.userId,
        bodyMarkdown,
      })
      .returning({ id: artifactNotes.id });
    await indexArtifactMetadata(tx, artifact.id);
    await recordAudit(tx, {
      action: "artifact.note_created",
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      targetType: "artifact",
      targetId: artifact.id,
      metadata: { noteId: note!.id },
      ...meta,
    });
    return noteById(tx, note!.id);
  });
}

/**
 * The artifact of a note in the actor's workspace, or null. Read without a lock: the caller
 * locks the artifact, then changes the note only if it still belongs to it.
 */
async function artifactOfNote(db: DbExecutor, actor: Actor, noteId: string) {
  const [note] = await db
    .select({ artifactId: artifactNotes.artifactId })
    .from(artifactNotes)
    .where(and(eq(artifactNotes.id, noteId), eq(artifactNotes.workspaceId, actor.workspaceId)));
  return note?.artifactId ?? null;
}

export async function updateNote(
  db: Database,
  actor: Actor,
  noteId: string,
  body: string,
  meta: RequestMeta,
): Promise<Note> {
  const bodyMarkdown = normalizeNoteBody(body);
  const artifactId = await artifactOfNote(db, actor, noteId);
  if (!artifactId) throw notFound("Note");
  return db.transaction(async (tx) => {
    await lockArtifact(tx, actor, artifactId);
    const [note] = await tx
      .update(artifactNotes)
      .set({ bodyMarkdown, updatedAt: new Date() })
      .where(and(eq(artifactNotes.id, noteId), eq(artifactNotes.artifactId, artifactId)))
      .returning({ id: artifactNotes.id });
    if (!note) throw notFound("Note");
    await indexArtifactMetadata(tx, artifactId);
    await recordAudit(tx, {
      action: "artifact.note_updated",
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      targetType: "artifact",
      targetId: artifactId,
      metadata: { noteId },
      ...meta,
    });
    return noteById(tx, noteId);
  });
}

export async function deleteNote(db: Database, actor: Actor, noteId: string, meta: RequestMeta) {
  const artifactId = await artifactOfNote(db, actor, noteId);
  if (!artifactId) throw notFound("Note");
  await db.transaction(async (tx) => {
    await lockArtifact(tx, actor, artifactId);
    const [note] = await tx
      .delete(artifactNotes)
      .where(and(eq(artifactNotes.id, noteId), eq(artifactNotes.artifactId, artifactId)))
      .returning({ id: artifactNotes.id });
    if (!note) throw notFound("Note");
    await indexArtifactMetadata(tx, artifactId);
    await recordAudit(tx, {
      action: "artifact.note_deleted",
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      targetType: "artifact",
      targetId: artifactId,
      metadata: { noteId },
      ...meta,
    });
  });
}

/** The actor's reading state of an artifact (already checked to be theirs to see). */
export async function readingStateOf(
  db: DbExecutor,
  actor: Actor,
  artifactId: string,
): Promise<ReadingState> {
  const [state] = await db
    .select({
      status: artifactReadingStates.status,
      isFavorite: artifactReadingStates.isFavorite,
      lastOpenedAt: artifactReadingStates.lastOpenedAt,
    })
    .from(artifactReadingStates)
    .where(
      and(
        eq(artifactReadingStates.userId, actor.userId),
        eq(artifactReadingStates.artifactId, artifactId),
      ),
    );
  return state ?? UNREAD;
}

/**
 * Changes the actor's reading state of a live artifact of their workspace. `opened` records
 * that they opened it now, and moves an unread artifact to "reading" unless `status` is given.
 */
export async function setReadingState(
  db: Database,
  actor: Actor,
  artifactId: string,
  input: { status?: ReadingStatus; isFavorite?: boolean; opened?: boolean },
): Promise<ReadingState> {
  if (input.status === undefined && input.isFavorite === undefined && !input.opened) {
    throw new AppError("VALIDATION_FAILED", "Nothing to update");
  }
  return db.transaction(async (tx) => {
    // Shared lock, re-checked: a soft delete that commits meanwhile wins.
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
      .for("share");
    if (!artifact) throw notFound("Artifact");
    const now = new Date();
    const opened = input.opened ? { lastOpenedAt: now } : {};
    const status =
      input.status ??
      (input.opened
        ? sql<ReadingStatus>`case when ${artifactReadingStates.status} = 'unread' then 'reading' else ${artifactReadingStates.status} end`
        : undefined);
    const [state] = await tx
      .insert(artifactReadingStates)
      .values({
        userId: actor.userId,
        workspaceId: actor.workspaceId,
        artifactId: artifact.id,
        status: input.status ?? (input.opened ? "reading" : "unread"),
        isFavorite: input.isFavorite ?? false,
        ...opened,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [artifactReadingStates.userId, artifactReadingStates.artifactId],
        set: {
          ...(status !== undefined ? { status } : {}),
          ...(input.isFavorite !== undefined ? { isFavorite: input.isFavorite } : {}),
          ...opened,
          updatedAt: now,
        },
      })
      .returning({
        status: artifactReadingStates.status,
        isFavorite: artifactReadingStates.isFavorite,
        lastOpenedAt: artifactReadingStates.lastOpenedAt,
      });
    return state!;
  });
}
