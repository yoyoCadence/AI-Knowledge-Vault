import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "@/infrastructure/database/client";
import {
  artifactSearchDocuments,
  artifactVersions,
  contentChunks,
  processingJobs,
  searchIndexStates,
} from "@/infrastructure/database/schema";
import type { Actor } from "@/modules/auth";
import {
  enqueueMissingIndexes,
  indexTokens,
  SEARCH_REINDEX_ALL_JOB_TYPE,
  searchArtifacts,
  TOKENIZER_VERSION,
} from "@/modules/search";
import { enqueueDueMaintenance, MAINTENANCE_JOBS, ONCE_JOBS } from "@/worker/scheduler";
import { htmlDocument } from "@tests/fixtures/builders";
import { closeTestDb, testDb } from "../helpers/db";
import { createTestActor, drainJobs, newBatch, uploadFile } from "../helpers/imports";

/**
 * Script folding (SEARCH_DESIGN §2, tokenizer 2): Traditional and Simplified text find each
 * other, the move from tokenizer 1 loses nothing while the index is rebuilt, and the rebuild is
 * queued once, at the first worker start with the new tokenizer.
 */

const db = testDb();

afterAll(async () => {
  await closeDb();
  await closeTestDb();
});

async function importHtml(actor: Actor, filename: string, title: string, body: string) {
  const item = await uploadFile(actor, (await newBatch(actor)).id, {
    filename,
    bytes: htmlDocument({ title, body: `<p>${body}</p>` }),
  });
  await drainJobs();
  const [version] = await db
    .select({ id: artifactVersions.id, artifactId: artifactVersions.artifactId })
    .from(artifactVersions)
    .where(eq(artifactVersions.importItemId, item.id));
  return version!;
}

const titles = async (actor: Actor, q: string) =>
  (await searchArtifacts(db, actor, { q })).items.map((item) => item.title).sort();

/** A tsvector literal as tokenizer 1 wrote it: no folding. */
function unfoldedTsvector(text: string): string {
  const positions = new Map<string, number[]>();
  for (const token of indexTokens(text, 1, false)) {
    positions.set(token.lexeme, [...(positions.get(token.lexeme) ?? []), token.position]);
  }
  return [...positions]
    .map(([lexeme, list]) => `'${lexeme}':${list.map((position) => `${position}D`).join(",")}`)
    .join(" ");
}

describe("Traditional / Simplified folding", () => {
  it("finds Traditional text with a Simplified query and the other way round", async () => {
    const actor = await createTestActor();
    await importHtml(actor, "tw.html", "臺北的熱島", "臺北盆地的都市熱島效應逐年增強。");
    await importHtml(actor, "cn.html", "上海的热岛", "上海的城市热岛形态正在改变。");

    expect(await titles(actor, "热岛")).toEqual(["上海的热岛", "臺北的熱島"]);
    expect(await titles(actor, "熱島")).toEqual(["上海的热岛", "臺北的熱島"]);
    expect(await titles(actor, "形態")).toEqual(["上海的热岛"]);
    expect(await titles(actor, "盆地 效應")).toEqual(["臺北的熱島"]);

    // The snippet highlights the original characters, whatever script the query used.
    const [hit] = (await searchArtifacts(db, actor, { q: "效应" })).items;
    expect(hit!.snippet!.segments.filter((segment) => segment.highlight)).toEqual([
      { text: "效應", highlight: true },
    ]);
  });

  it("keeps finding text indexed by tokenizer 1 until it is re-indexed, then folds it", async () => {
    const actor = await createTestActor();
    const version = await importHtml(actor, "old.html", "舊索引", "颱風與海平面的關係研究。");

    // Put the version back as tokenizer 1 left it: unfolded chunks, an old index state and no
    // usable metadata document.
    const chunks = await db
      .select({ id: contentChunks.id, text: contentChunks.text })
      .from(contentChunks)
      .where(eq(contentChunks.artifactVersionId, version.id));
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      await db
        .update(contentChunks)
        .set({ searchVector: unfoldedTsvector(chunk.text), tokenizerVersion: 1 })
        .where(eq(contentChunks.id, chunk.id));
    }
    await db
      .update(artifactSearchDocuments)
      .set({ searchVector: "", tokenizerVersion: 1 })
      .where(eq(artifactSearchDocuments.artifactId, version.artifactId));
    await db
      .update(searchIndexStates)
      .set({ tokenizerVersion: 1 })
      .where(eq(searchIndexStates.artifactVersionId, version.id));

    // A Traditional query still matches the old lexemes (its literal form); a Simplified one
    // cannot yet: that is what re-indexing at once is for.
    expect(await titles(actor, "颱風 關係")).toEqual(["舊索引"]);
    expect(await titles(actor, "关系")).toEqual([]);

    expect(await enqueueMissingIndexes(db)).toBeGreaterThan(0);
    await drainJobs();
    const [state] = await db
      .select({ tokenizerVersion: searchIndexStates.tokenizerVersion })
      .from(searchIndexStates)
      .where(eq(searchIndexStates.artifactVersionId, version.id));
    expect(state!.tokenizerVersion).toBe(TOKENIZER_VERSION);
    expect(await titles(actor, "关系")).toEqual(["舊索引"]);
    expect(await titles(actor, "颱風 關係")).toEqual(["舊索引"]);
  });

  it("queues the re-index for a new tokenizer once, not daily", async () => {
    const [once] = ONCE_JOBS;
    expect(once).toEqual({
      type: SEARCH_REINDEX_ALL_JOB_TYPE,
      idempotencyKey: `${SEARCH_REINDEX_ALL_JOB_TYPE}:tokenizer:${TOKENIZER_VERSION}`,
    });
    const now = new Date("2031-01-01T00:00:00Z");
    await enqueueDueMaintenance(db, now);
    await enqueueDueMaintenance(db, new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000));
    const queued = await db
      .select({ key: processingJobs.idempotencyKey })
      .from(processingJobs)
      .where(eq(processingJobs.idempotencyKey, once!.idempotencyKey));
    expect(queued).toHaveLength(1);

    // Leave no runnable maintenance behind for later test files (see archives.test.ts).
    await db.delete(processingJobs).where(
      and(
        inArray(
          processingJobs.type,
          MAINTENANCE_JOBS.map((job) => job.type),
        ),
        eq(processingJobs.status, "queued"),
      ),
    );
  });
});
