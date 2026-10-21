import { and, eq } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "@/infrastructure/database/client";
import {
  artifacts,
  collectionItems,
  collections,
  importBatches,
} from "@/infrastructure/database/schema";
import { AppError } from "@/lib/errors";
import { listArtifacts } from "@/modules/artifacts";
import type { Actor } from "@/modules/auth";
import {
  createCollection,
  deleteCollection,
  findCollection,
  getArtifactCollections,
  listCollections,
  normalizeCollectionName,
  setCollectionItem,
  updateCollection,
} from "@/modules/collections";
import { searchArtifacts } from "@/modules/search";
import { htmlDocument } from "@tests/fixtures/builders";
import { closeTestDb, testDb } from "../helpers/db";
import { createTestActor, drainJobs, newBatch, uploadFile } from "../helpers/imports";

const db = testDb();
const meta = { ipAddress: null, userAgent: "vitest" };
const code = (error: unknown) => (error instanceof AppError ? error.code : String(error));

afterAll(async () => {
  await closeDb();
  await closeTestDb();
});

async function importOne(actor: Actor, filename: string, title: string, batchId?: string) {
  await uploadFile(actor, batchId ?? (await newBatch(actor)).id, {
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

const put = (actor: Actor, collectionId: string, artifactId: string, present = true) =>
  setCollectionItem(db, actor, { collectionId, artifactId, present }, meta);

const listedIds = async (actor: Actor, collectionId: string) =>
  (await listArtifacts(db, actor, { limit: 50, filters: { collectionId } })).items.map(
    (item) => item.id,
  );

describe("collections (FR-LIB-5, API_CONTRACT §6)", () => {
  let owner: Actor;
  let stranger: Actor;

  beforeAll(async () => {
    owner = await createTestActor();
    stranger = await createTestActor();
  });

  it("builds a tree, lists it depth-first with counts, and keeps sibling names distinct", async () => {
    const city = await createCollection(db, owner, { name: "城市", kind: "category" }, meta);
    const heat = await createCollection(db, owner, { name: "熱島", parentId: city.id }, meta);
    const water = await createCollection(db, owner, { name: "  水資源 ", parentId: city.id }, meta);
    const reading = await createCollection(db, owner, { name: "待讀" }, meta);
    expect(water.name).toBe("水資源");
    expect(heat).toMatchObject({ kind: "collection", parentId: city.id });

    const tree = (await listCollections(db, owner)).filter((row) =>
      [city.id, heat.id, water.id, reading.id].includes(row.id),
    );
    expect(tree.map((row) => [row.name, row.depth])).toEqual([
      ["城市", 0],
      ["水資源", 1],
      ["熱島", 1],
      ["待讀", 0],
    ]);
    expect(await listCollections(db, stranger)).toEqual([]);

    // Names compare as the app compares them (NFKC, case, spaces), among siblings only.
    await createCollection(db, owner, { name: "AI 模型" }, meta);
    for (const [name, parentId] of [
      ["ＡＩ\u3000模型", null],
      ["熱島", city.id],
      ["待讀", null],
    ] as const) {
      await expect(createCollection(db, owner, { name, parentId }, meta), name).rejects.toSatisfy(
        (error) => code(error) === "CONFLICT",
      );
    }
    // The same name elsewhere in the tree is fine.
    await createCollection(db, owner, { name: "熱島", parentId: reading.id }, meta);
    await expect(updateCollection(db, owner, water.id, { name: "熱島" }, meta)).rejects.toSatisfy(
      (error) => code(error) === "CONFLICT",
    );

    for (const name of ["", "   ", "\u200b", "abc\u202eexe", "x".repeat(101)]) {
      expect(() => normalizeCollectionName(name), JSON.stringify(name)).toThrow();
    }
    await expect(updateCollection(db, owner, city.id, {}, meta)).rejects.toSatisfy(
      (error) => code(error) === "VALIDATION_FAILED",
    );
  });

  it("refuses cycles and trees deeper than seven levels", async () => {
    const chain: string[] = [];
    let parentId: string | null = null;
    for (let level = 0; level < 7; level += 1) {
      const created: { id: string } = await createCollection(
        db,
        owner,
        { name: `深度 ${level}`, parentId },
        meta,
      );
      chain.push(created.id);
      parentId = created.id;
    }
    await expect(
      createCollection(db, owner, { name: "太深", parentId: chain[6]! }, meta),
    ).rejects.toSatisfy((error) => code(error) === "VALIDATION_FAILED");

    // Into itself or its own subtree: refused as a cycle even where the depth would allow it.
    const x = await createCollection(db, owner, { name: "環 X" }, meta);
    const y = await createCollection(db, owner, { name: "環 Y", parentId: x.id }, meta);
    for (const target of [x.id, y.id]) {
      await expect(updateCollection(db, owner, x.id, { parentId: target }, meta)).rejects.toSatisfy(
        (error) => code(error) === "VALIDATION_FAILED",
      );
    }
    for (const target of [chain[0]!, chain[3]!]) {
      await expect(
        updateCollection(db, owner, chain[0]!, { parentId: target }, meta),
      ).rejects.toSatisfy((error) => code(error) === "VALIDATION_FAILED");
    }
    // A two-level subtree moved under level 5 would end at level 8.
    const twig = await createCollection(db, owner, { name: "小枝" }, meta);
    await createCollection(db, owner, { name: "葉", parentId: twig.id }, meta);
    await expect(
      updateCollection(db, owner, twig.id, { parentId: chain[5]! }, meta),
    ).rejects.toSatisfy((error) => code(error) === "VALIDATION_FAILED");
    await updateCollection(db, owner, twig.id, { parentId: chain[4]! }, meta);
    const moved = (await listCollections(db, owner)).find((row) => row.id === twig.id);
    expect(moved).toMatchObject({ parentId: chain[4], depth: 5 });
    // And back to the top.
    await updateCollection(db, owner, twig.id, { parentId: null }, meta);
    expect((await findCollection(db, owner, twig.id))?.parentId).toBeNull();
  });

  it("puts artifacts in collections; the filter includes subcollections", async () => {
    const top = await createCollection(db, owner, { name: "能源", kind: "category" }, meta);
    const solar = await createCollection(db, owner, { name: "太陽能", parentId: top.id }, meta);
    const a = await importOne(owner, "solar-roof.html", "屋頂光電");
    const b = await importOne(owner, "grid.html", "電網調度");
    await importOne(owner, "elsewhere.html", "不在集合");

    const paths = await put(owner, solar.id, a);
    expect(paths).toEqual([{ id: solar.id, name: "太陽能", path: ["能源", "太陽能"] }]);
    expect(await put(owner, solar.id, a)).toEqual(paths); // idempotent
    await put(owner, top.id, b);
    expect((await getArtifactCollections(db, owner, a)).map((row) => row.id)).toEqual([solar.id]);

    expect(new Set(await listedIds(owner, top.id))).toEqual(new Set([a, b]));
    expect(await listedIds(owner, solar.id)).toEqual([a]);
    const searched = await searchArtifacts(db, owner, {
      q: "屋頂光電",
      filters: { collectionId: top.id },
    });
    expect(searched.items.map((item) => item.id)).toEqual([a]);
    // Another workspace's collection filters to nothing.
    expect(await listedIds(stranger, top.id)).toEqual([]);

    const counts = new Map(
      (await listCollections(db, owner)).map((row) => [row.id, row.artifactCount]),
    );
    expect([counts.get(top.id), counts.get(solar.id)]).toEqual([1, 1]);
    // A deleted artifact is not counted and cannot be added (deletion has no API yet).
    await db.update(artifacts).set({ deletedAt: new Date() }).where(eq(artifacts.id, b));
    expect((await listCollections(db, owner)).find((row) => row.id === top.id)?.artifactCount).toBe(
      0,
    );
    await expect(put(owner, solar.id, b)).rejects.toSatisfy((error) => code(error) === "NOT_FOUND");

    await put(owner, solar.id, a, false);
    await put(owner, solar.id, a, false); // idempotent
    expect(await listedIds(owner, top.id)).toEqual([]);
  });

  it("deletes only leaf collections; their artifacts stay in the library", async () => {
    const parent = await createCollection(db, owner, { name: "可刪除" }, meta);
    const child = await createCollection(db, owner, { name: "子集合", parentId: parent.id }, meta);
    const artifactId = await importOne(owner, "keep-me.html", "留在書庫");
    await put(owner, child.id, artifactId);

    await expect(deleteCollection(db, owner, parent.id, meta)).rejects.toSatisfy(
      (error) =>
        error instanceof AppError &&
        error.code === "CONFLICT" &&
        error.details?.reason === "HAS_CHILDREN",
    );
    await deleteCollection(db, owner, child.id, meta);
    await deleteCollection(db, owner, parent.id, meta);
    expect(await findCollection(db, owner, parent.id)).toBeNull();
    expect(
      await db.select().from(collectionItems).where(eq(collectionItems.artifactId, artifactId)),
    ).toEqual([]);
    const [artifact] = await db
      .select({ deletedAt: artifacts.deletedAt })
      .from(artifacts)
      .where(eq(artifacts.id, artifactId));
    expect(artifact).toEqual({ deletedAt: null });
    await expect(deleteCollection(db, owner, parent.id, meta)).rejects.toSatisfy(
      (error) => code(error) === "NOT_FOUND",
    );
  });

  it("is invisible to other workspaces", async () => {
    const mine = await createCollection(db, owner, { name: "私人集合" }, meta);
    const artifactId = await importOne(owner, "private-in-collection.html", "私人作品");
    const theirs = await createCollection(db, stranger, { name: "他們的" }, meta);
    const theirArtifact = await importOne(stranger, "their-artifact.html", "他們的作品");

    expect(await findCollection(db, stranger, mine.id)).toBeNull();
    for (const attempt of [
      () => updateCollection(db, stranger, mine.id, { name: "偷改" }, meta),
      () => deleteCollection(db, stranger, mine.id, meta),
      () => createCollection(db, stranger, { name: "掛上去", parentId: mine.id }, meta),
      () => updateCollection(db, stranger, theirs.id, { parentId: mine.id }, meta),
      () => put(stranger, mine.id, theirArtifact),
      () => put(stranger, theirs.id, artifactId),
      () => put(owner, theirs.id, artifactId),
      () => getArtifactCollections(db, stranger, artifactId),
    ]) {
      await expect(attempt()).rejects.toSatisfy((error) => code(error) === "NOT_FOUND");
    }
  });

  it("imports into a collection, and imports normally once that collection is gone", async () => {
    const inbox = await createCollection(db, owner, { name: "匯入收件匣" }, meta);
    const batch = await newBatch(owner, { collectionId: inbox.id });
    expect(batch.targetCollectionId).toBe(inbox.id);
    const imported = await importOne(owner, "into-collection.html", "直接進集合", batch.id);
    expect(await listedIds(owner, inbox.id)).toEqual([imported]);

    // A new version keeps the artifact where its owner put it.
    await put(owner, inbox.id, imported, false);
    await uploadFile(owner, batch.id, {
      filename: "into-collection.html",
      bytes: htmlDocument({ title: "直接進集合", body: "<p>第二版</p>" }),
    });
    await drainJobs();
    expect(await listedIds(owner, inbox.id)).toEqual([]);

    const later = await newBatch(owner, { collectionId: inbox.id });
    await deleteCollection(db, owner, inbox.id, meta);
    const [cleared] = await db
      .select({ target: importBatches.targetCollectionId })
      .from(importBatches)
      .where(eq(importBatches.id, later.id));
    expect(cleared).toEqual({ target: null });
    const orphan = await importOne(owner, "after-delete.html", "集合已刪除", later.id);
    expect(await getArtifactCollections(db, owner, orphan)).toEqual([]);

    const theirs = await createCollection(db, stranger, { name: "別人的收件匣" }, meta);
    await expect(newBatch(owner, { collectionId: theirs.id })).rejects.toSatisfy(
      (error) => code(error) === "NOT_FOUND",
    );
  });

  it("two concurrent moves cannot close a cycle", async () => {
    // A > B, and C on top. Move C under B and A under C at the same time: each alone is fine,
    // together they make A > B > C > A. The second must see the first and be refused.
    const a = await createCollection(db, owner, { name: "環 A" }, meta);
    const b = await createCollection(db, owner, { name: "環 B", parentId: a.id }, meta);
    const c = await createCollection(db, owner, { name: "環 C" }, meta);

    const blocker = new Client({ connectionString: process.env.DATABASE_URL });
    const watcher = new Client({ connectionString: process.env.DATABASE_URL });
    await blocker.connect();
    await watcher.connect();
    const waiting = async (minimum: number) => {
      for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
        const { rows } = await watcher.query(
          `select count(*)::int as n from pg_stat_activity
           where wait_event_type = 'Lock'
             and (query ilike '%update "collections"%' or query ilike '%pg_advisory_xact_lock%')`,
        );
        if ((rows[0] as { n: number }).n >= minimum) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`fewer than ${minimum} moves are waiting`);
    };
    try {
      // Hold B so the first move stops at its update, after its cycle check and while it holds
      // the tree lock; then start the second.
      await blocker.query("begin");
      await blocker.query("select id from collections where id = $1 for update", [b.id]);
      const first = updateCollection(db, owner, c.id, { parentId: b.id }, meta);
      first.catch(() => undefined);
      await waiting(1);
      const second = updateCollection(db, owner, a.id, { parentId: c.id }, meta);
      second.catch(() => undefined);
      await waiting(2);
      await blocker.query("rollback");
      const results = await Promise.allSettled([first, second]);
      expect(results[0].status).toBe("fulfilled");
      expect(results[1].status).toBe("rejected");
      expect(code((results[1] as PromiseRejectedResult).reason)).toBe("VALIDATION_FAILED");
    } finally {
      await blocker.end();
      await watcher.end();
    }
    const rows = await db
      .select({ id: collections.id, parentId: collections.parentId })
      .from(collections)
      .where(eq(collections.workspaceId, owner.workspaceId));
    const parentOf = new Map(rows.map((row) => [row.id, row.parentId]));
    expect(parentOf.get(a.id)).toBeNull();
    expect(parentOf.get(c.id)).toBe(b.id);
  });
});
