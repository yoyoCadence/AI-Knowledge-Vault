import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEnv } from "@/infrastructure/config/env";
import { closeDb } from "@/infrastructure/database/client";
import { artifacts, workspaceMembers } from "@/infrastructure/database/schema";
import { AppError } from "@/lib/errors";
import { newId } from "@/lib/ids";
import { listArtifacts } from "@/modules/artifacts";
import type { Actor } from "@/modules/auth";
import { PATHS, restoreArchive, restoreLimitsFromEnv, writeExport } from "@/modules/backup";
import { getStorage } from "@/infrastructure/storage";
import { SafeZip } from "@/modules/extraction";
import {
  createNote,
  deleteNote,
  listNotes,
  normalizeNoteBody,
  readingStateOf,
  setReadingState,
  updateNote,
} from "@/modules/notes";
import { searchArtifacts } from "@/modules/search";
import { htmlDocument } from "@tests/fixtures/builders";
import { createTestAdmin } from "../helpers/auth";
import { closeTestDb, testDb } from "../helpers/db";
import { createTestActor, drainJobs, newBatch, uploadFile } from "../helpers/imports";

const db = testDb();
const meta = { ipAddress: null, userAgent: "vitest" };
const code = (error: unknown) => (error instanceof AppError ? error.code : String(error));

afterAll(async () => {
  await closeDb();
  await closeTestDb();
});

async function importOne(actor: Actor, filename: string, title: string) {
  await uploadFile(actor, (await newBatch(actor)).id, {
    filename,
    bytes: htmlDocument({ title, body: `<p>${title}的內容</p>` }),
  });
  await drainJobs();
  const [row] = await db
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(and(eq(artifacts.workspaceId, actor.workspaceId), eq(artifacts.title, title)));
  return row!.id;
}

/** A second member of `owner`'s workspace. */
async function memberOf(owner: Actor, role: "editor" | "viewer"): Promise<Actor> {
  const user = await createTestAdmin();
  await db.insert(workspaceMembers).values({
    workspaceId: owner.workspaceId,
    userId: user.userId,
    role,
  });
  return {
    userId: user.userId,
    workspaceId: owner.workspaceId,
    role,
    sessionId: newId(),
    email: user.email,
    name: "Member",
  };
}

const searchIds = async (actor: Actor, q: string) =>
  (await searchArtifacts(db, actor, { q })).items.map((item) => item.id);

const listedIds = async (actor: Actor, options: Parameters<typeof listArtifacts>[2]) =>
  (await listArtifacts(db, actor, options)).items.map((item) => item.id);

describe("notes (FR-LIB-8, API_CONTRACT §6)", () => {
  let owner: Actor;
  let stranger: Actor;
  let artifactId: string;

  beforeAll(async () => {
    owner = await createTestActor();
    stranger = await createTestActor();
    artifactId = await importOne(owner, "noted.html", "有筆記的作品");
  });

  it("creates, lists, edits and deletes notes; search follows", async () => {
    const first = await createNote(
      db,
      owner,
      artifactId,
      "  第一則：珊瑚白化\r\n\r\n- 觀測點  ",
      meta,
    );
    expect(first).toMatchObject({ bodyMarkdown: "第一則：珊瑚白化\n\n- 觀測點" });
    expect(first.authorName).toBeTruthy();
    const second = await createNote(db, owner, artifactId, "第二則", meta);
    expect((await listNotes(db, owner, artifactId)).map((note) => note.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(await searchIds(owner, "珊瑚白化")).toEqual([artifactId]);

    const edited = await updateNote(db, owner, first.id, "改寫：海草床", meta);
    expect(edited.bodyMarkdown).toBe("改寫：海草床");
    expect(await searchIds(owner, "珊瑚白化")).toEqual([]);
    expect(await searchIds(owner, "海草床")).toEqual([artifactId]);

    await deleteNote(db, owner, first.id, meta);
    expect(await searchIds(owner, "海草床")).toEqual([]);
    expect((await listNotes(db, owner, artifactId)).map((note) => note.id)).toEqual([second.id]);
    await expect(deleteNote(db, owner, first.id, meta)).rejects.toSatisfy(
      (error) => code(error) === "NOT_FOUND",
    );
  });

  it("refuses empty, oversized and spoofed notes", async () => {
    for (const body of ["", "   \n ", "x".repeat(20_001), "a\u0000b", "a\u0007b", "abc\u202eexe"]) {
      expect(() => normalizeNoteBody(body), JSON.stringify(body.slice(0, 20))).toThrow();
      await expect(createNote(db, owner, artifactId, body, meta)).rejects.toSatisfy(
        (error) => code(error) === "VALIDATION_FAILED",
      );
    }
    expect(normalizeNoteBody("x".repeat(20_000))).toHaveLength(20_000);
  });

  it("is invisible to other workspaces and gone with a deleted artifact", async () => {
    const note = await createNote(db, owner, artifactId, "私人筆記", meta);
    for (const attempt of [
      () => listNotes(db, stranger, artifactId),
      () => createNote(db, stranger, artifactId, "闖入", meta),
      () => updateNote(db, stranger, note.id, "偷改", meta),
      () => deleteNote(db, stranger, note.id, meta),
      () => setReadingState(db, stranger, artifactId, { isFavorite: true }),
    ]) {
      await expect(attempt()).rejects.toSatisfy((error) => code(error) === "NOT_FOUND");
    }
    expect(await searchIds(stranger, "私人筆記")).toEqual([]);

    const doomed = await importOne(owner, "soon-deleted.html", "即將刪除");
    const kept = await createNote(db, owner, doomed, "留不住", meta);
    await db.update(artifacts).set({ deletedAt: new Date() }).where(eq(artifacts.id, doomed));
    for (const attempt of [
      () => listNotes(db, owner, doomed),
      () => createNote(db, owner, doomed, "太晚了", meta),
      () => updateNote(db, owner, kept.id, "太晚了", meta),
      () => setReadingState(db, owner, doomed, { opened: true }),
    ]) {
      await expect(attempt()).rejects.toSatisfy((error) => code(error) === "NOT_FOUND");
    }
  });

  it("keeps notes searchable when together they are longer than a tsvector can hold", async () => {
    // Unbounded, the metadata vector would pass Postgres' 1 MB tsvector limit after a few long
    // notes, and every later note write (and index job) on the artifact would fail.
    const target = await importOne(owner, "many-notes.html", "很多長筆記");
    let seed = 2_463_534_242; // xorshift32: varied pairs, so ~every bigram is distinct
    const longNote = () =>
      Array.from({ length: 20_000 }, () => {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        return String.fromCodePoint(0x4e00 + ((seed >>> 0) % 20_000));
      }).join("");
    for (let index = 0; index < 8; index += 1) {
      await createNote(db, owner, target, longNote(), meta);
    }
    await createNote(db, owner, target, "最新的筆記：藻礁", meta);
    expect(await searchIds(owner, "很多長筆記")).toEqual([target]);
    // The newest notes are the ones kept searchable.
    expect(await searchIds(owner, "藻礁")).toEqual([target]);
  });

  it("a long note never makes the artifact's other fields unsearchable", async () => {
    // Notes come last in the metadata document: a note long enough to reach the last tsvector
    // position must not push the source fields (here the original filename) past it.
    const target = await importOne(owner, "濕地復育計畫書.html", "長筆記不擠掉檔名");
    let seed = 88_675_123;
    const long = Array.from({ length: 17_000 }, () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return String.fromCodePoint(0x4e00 + ((seed >>> 0) % 20_000));
    }).join("");
    expect(await searchIds(owner, "濕地復育計畫書")).toEqual([target]);
    await createNote(db, owner, target, long, meta);
    expect(await searchIds(owner, "濕地復育計畫書")).toEqual([target]);
  });

  it("restores a note of characters outside the Basic Multilingual Plane", async () => {
    // 10,001 emoji are 10,001 characters (the app's and the database's count) but 20,002
    // UTF-16 units: the archive must accept what the app accepted.
    const source = await createTestActor();
    const noted = await importOne(source, "emoji-note.html", "表情符號筆記");
    const body = "\u{1f30f}".repeat(10_001);
    await createNote(db, source, noted, body, meta);
    const dir = await mkdtemp(path.join(tmpdir(), "vault-notes-emoji-"));
    try {
      const file = path.join(dir, "export.zip");
      await writeExport(db, getStorage(), source.workspaceId, createWriteStream(file));
      const target = await createTestActor();
      const report = await restoreArchive(db, getStorage(), {
        archivePath: file,
        workspaceId: target.workspaceId,
        userId: target.userId,
        mode: "skip_existing",
        restoreId: crypto.randomUUID(),
        limits: restoreLimitsFromEnv(getEnv()),
      });
      expect(report.counts.notes.copied).toBe(1);
      const [restoredId] = Object.entries(report.idMap)
        .filter(([oldId]) => oldId === noted)
        .map(([, newId]) => newId);
      expect((await listNotes(db, target, restoredId!))[0]!.bodyMarkdown).toBe(body);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("two notes written on one artifact at the same time do not deadlock", async () => {
    // Each note write locks the artifact before inserting. If it inserted first, both inserts
    // would hold the foreign key's key-share lock and each re-index would wait for the other.
    const target = await importOne(owner, "busy.html", "同時寫筆記");
    const blocker = new Client({ connectionString: process.env.DATABASE_URL });
    const watcher = new Client({ connectionString: process.env.DATABASE_URL });
    await blocker.connect();
    await watcher.connect();
    try {
      await blocker.query("begin");
      await blocker.query("select id from artifacts where id = $1 for key share", [target]);
      const writes = [
        createNote(db, owner, target, "同時 A", meta),
        createNote(db, owner, target, "同時 B", meta),
      ];
      for (const write of writes) write.catch(() => undefined);
      for (const deadline = Date.now() + 10_000; ;) {
        const { rows } = await watcher.query(
          `select count(*)::int as n from pg_stat_activity
           where wait_event_type = 'Lock' and query ilike '%"artifacts"%for update%'`,
        );
        if ((rows[0] as { n: number }).n >= 2) break;
        if (Date.now() > deadline) throw new Error("the writes never waited");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await blocker.query("rollback");
      const results = await Promise.allSettled(writes);
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    } finally {
      await blocker.end();
      await watcher.end();
    }
    expect(await listNotes(db, owner, target)).toHaveLength(2);
  });
});

describe("reading state (FR-LIB-8)", () => {
  let owner: Actor;
  let member: Actor;
  let a: string;
  let b: string;
  let c: string;

  beforeAll(async () => {
    owner = await createTestActor();
    member = await memberOf(owner, "viewer");
    a = await importOne(owner, "state-a.html", "狀態 A");
    b = await importOne(owner, "state-b.html", "狀態 B");
    c = await importOne(owner, "state-c.html", "狀態 C");
  });

  it("records opening, status and favorite, per user", async () => {
    expect(await readingStateOf(db, owner, a)).toEqual({
      status: "unread",
      isFavorite: false,
      lastOpenedAt: null,
    });
    const opened = await setReadingState(db, owner, a, { opened: true });
    expect(opened.status).toBe("reading");
    expect(opened.lastOpenedAt).toBeInstanceOf(Date);
    // Opening again keeps a status the user chose.
    await setReadingState(db, owner, a, { status: "read" });
    expect((await setReadingState(db, owner, a, { opened: true })).status).toBe("read");
    expect(await setReadingState(db, owner, a, { isFavorite: true })).toMatchObject({
      status: "read",
      isFavorite: true,
    });
    // A favorite set before any opening starts unread.
    expect(await setReadingState(db, owner, b, { isFavorite: true })).toMatchObject({
      status: "unread",
      isFavorite: true,
      lastOpenedAt: null,
    });
    await expect(setReadingState(db, owner, a, {})).rejects.toSatisfy(
      (error) => code(error) === "VALIDATION_FAILED",
    );

    // Another member (a viewer may keep their own state) sees their own, not the owner's.
    expect(await readingStateOf(db, member, a)).toMatchObject({ status: "unread" });
    await setReadingState(db, member, c, { opened: true });
    expect(await readingStateOf(db, owner, c)).toMatchObject({ lastOpenedAt: null });
  });

  it("filters the library and search by the actor's own state, and lists recently opened", async () => {
    // Owner: a read + favorite, b favorite (unread), c untouched by the owner.
    expect(new Set(await listedIds(owner, { limit: 50, filters: { favorite: true } }))).toEqual(
      new Set([a, b]),
    );
    expect(await listedIds(owner, { limit: 50, filters: { readingStatus: "read" } })).toEqual([a]);
    expect(
      new Set(await listedIds(owner, { limit: 50, filters: { readingStatus: "unread" } })),
    ).toEqual(new Set([b, c]));
    expect(await listedIds(member, { limit: 50, filters: { favorite: true } })).toEqual([]);
    expect(
      (await searchArtifacts(db, owner, { q: "狀態", filters: { favorite: true } })).items
        .map((item) => item.id)
        .sort(),
    ).toEqual([a, b].sort());

    const cards = (await listArtifacts(db, owner, { limit: 50 })).items;
    expect(cards.find((card) => card.id === a)).toMatchObject({
      readingStatus: "read",
      isFavorite: true,
    });
    expect(cards.find((card) => card.id === c)).toMatchObject({
      readingStatus: "unread",
      isFavorite: false,
      lastOpenedAt: null,
    });

    // Recently opened: only opened artifacts, latest first, page by page.
    await setReadingState(db, owner, c, { opened: true });
    await setReadingState(db, owner, a, { opened: true });
    const first = await listArtifacts(db, owner, { limit: 1, sort: "opened" });
    expect(first.items.map((item) => item.id)).toEqual([a]);
    const second = await listArtifacts(db, owner, {
      limit: 1,
      sort: "opened",
      cursor: first.nextCursor!,
    });
    expect(second.items.map((item) => item.id)).toEqual([c]);
    expect(second.nextCursor).toBeNull();
    expect(await listedIds(member, { limit: 50, sort: "opened" })).toEqual([c]);
  });

  it("exports one state per artifact, merged over the members", async () => {
    // a: owner read + favorite; the viewer only opened it. b: owner's favorite. c: both opened.
    await setReadingState(db, member, a, { opened: true });
    const dir = await mkdtemp(path.join(tmpdir(), "vault-notes-export-"));
    try {
      const file = path.join(dir, "export.zip");
      await writeExport(db, getStorage(), owner.workspaceId, createWriteStream(file));
      const zip = await SafeZip.open(file, restoreLimitsFromEnv(getEnv()));
      const states = JSON.parse(
        (await zip.readBuffer(PATHS.readingStates, 1024 * 1024)).toString("utf8"),
      ) as { artifactId: string; status: string; isFavorite: boolean; lastOpenedAt: string }[];
      zip.close();
      const byId = new Map(states.map((state) => [state.artifactId, state]));
      expect(byId.get(a)).toMatchObject({ status: "read", isFavorite: true });
      expect(byId.get(b)).toMatchObject({ status: "unread", isFavorite: true, lastOpenedAt: null });
      expect(byId.get(c)).toMatchObject({ status: "reading", isFavorite: false });
      // The latest opening of anyone.
      const opened = await Promise.all(
        [owner, member].map(async (actor) => (await readingStateOf(db, actor, a)).lastOpenedAt!),
      );
      expect(new Date(byId.get(a)!.lastOpenedAt).getTime()).toBe(
        Math.max(...opened.map((at) => at.getTime())),
      );
      expect(states).toHaveLength(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
