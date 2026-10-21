import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "@/infrastructure/database/client";
import {
  artifacts,
  artifactSearchDocuments,
  artifactVersions,
  contentChunks,
  searchIndexStates,
} from "@/infrastructure/database/schema";
import type { Actor } from "@/modules/auth";
import { enqueueMissingIndexes, indexArtifactMetadata, searchArtifacts } from "@/modules/search";
import { htmlDocument } from "@tests/fixtures/builders";
import { closeTestDb, testDb } from "../helpers/db";
import { createTestActor, drainJobs, newBatch, uploadFile } from "../helpers/imports";

const db = testDb();

afterAll(async () => {
  await closeDb();
  await closeTestDb();
});

/** `body` is one paragraph of text, or HTML when it starts with `<`. */
async function importHtml(actor: Actor, filename: string, title: string, body: string) {
  const item = await uploadFile(actor, (await newBatch(actor)).id, {
    filename,
    bytes: htmlDocument({ title, body: body.startsWith("<") ? body : `<p>${body}</p>` }),
  });
  await drainJobs();
  const [version] = await db
    .select({ artifactId: artifactVersions.artifactId })
    .from(artifactVersions)
    .where(eq(artifactVersions.importItemId, item.id));
  return version!.artifactId;
}

const titles = async (actor: Actor, q: string) =>
  (await searchArtifacts(db, actor, { q })).items.map((item) => item.title).sort();

describe("keyword search (SEARCH_DESIGN §7)", () => {
  let owner: Actor;
  let adjacent: string;

  beforeAll(async () => {
    owner = await createTestActor();
    adjacent = await importHtml(
      owner,
      "heat-island.html",
      "都市研究甲",
      "城市綠廊降低地表溫度與鋪面蓄熱。",
    );
    // Every bigram of 城市綠廊 (城市, 市綠, 綠廊) occurs here, but never in sequence.
    await importHtml(owner, "planning.html", "都市研究乙", "城市規劃影響市綠化，也影響綠廊。");
    await importHtml(
      owner,
      "comfort.html",
      "Comfort notes",
      "Urban thermal comfort, measured with AI模型 v2.",
    );
  });

  it("finds a 2-character word anywhere it occurs", async () => {
    expect(await titles(owner, "城市")).toEqual(["都市研究乙", "都市研究甲"]);
  });

  it("matches a 4-character phrase only where it is contiguous", async () => {
    // 乙 contains all three bigrams, only apart: adjacency (<->) is what excludes it.
    expect(await titles(owner, "城市綠廊")).toEqual(["都市研究甲"]);
  });

  it("searches the summary (the fixture's meta description) as metadata", async () => {
    // htmlDocument() always describes itself as 「都市熱島效應的成因與對策摘要。」
    expect(await titles(owner, "對策摘要")).toEqual(["Comfort notes", "都市研究乙", "都市研究甲"]);
  });

  it("handles English prefixes, mixed scripts and full-width input", async () => {
    expect(await titles(owner, "therm")).toEqual(["Comfort notes"]);
    expect(await titles(owner, "ＡＩ")).toEqual(["Comfort notes"]);
    expect(await titles(owner, "ai 模型")).toEqual(["Comfort notes"]);
    expect(await titles(owner, '"urban thermal"')).toEqual(["Comfort notes"]);
    expect(await titles(owner, '"thermal urban"')).toEqual([]);
  });

  it("searches titles and ranks metadata hits", async () => {
    expect(await titles(owner, "都市研究甲")).toEqual(["都市研究甲"]);
    const { items } = await searchArtifacts(db, owner, { q: "都市研究" });
    expect(items).toHaveLength(2);
    // A title hit (weight A, metadata counts double) outranks a body-only hit (weight D).
    const actor = await createTestActor();
    await importHtml(actor, "body-only.html", "其他主題", "這段內文提到綠屋頂。");
    await importHtml(actor, "title-hit.html", "綠屋頂", "內文與主題無關。");
    const ranked = await searchArtifacts(db, actor, { q: "綠屋頂" });
    expect(ranked.items.map((item) => item.title)).toEqual(["綠屋頂", "其他主題"]);
    expect(ranked.items[0]!.score).toBeGreaterThan(ranked.items[1]!.score);
  });

  it("requires every term somewhere in the artifact, not in one chunk", async () => {
    // 對策 is only in the description (metadata), 綠廊 only in the body (a chunk).
    expect(await titles(owner, "對策 綠廊")).toEqual(["都市研究乙", "都市研究甲"]);
    // heat is only in the file name (metadata); 綠廊 in the body.
    expect(await titles(owner, "heat 綠廊")).toEqual(["都市研究甲"]);
    expect(await titles(owner, "綠廊 不存在的詞")).toEqual([]);

    // Two sections are two chunks: one term in each still matches.
    const actor = await createTestActor();
    const id = await importHtml(
      actor,
      "sections.html",
      "分節測試",
      "<h2>第一節</h2><p>海綿城市的概念。</p><h2>第二節</h2><p>透水鋪面的做法。</p>",
    );
    const chunks = await db.select().from(contentChunks).where(eq(contentChunks.artifactId, id));
    expect(chunks.filter((chunk) => /海綿城市|透水鋪面/.test(chunk.text))).toHaveLength(2);
    expect(await titles(actor, "海綿城市 透水鋪面")).toEqual(["分節測試"]);
  });

  it("never matches a phrase across two metadata fields", async () => {
    expect(await titles(owner, '"comfort notes"')).toEqual(["Comfort notes"]);
    // The title ends with "notes" and the description starts with 都市: not a phrase.
    expect(await titles(owner, '"notes 都市"')).toEqual([]);
  });

  it("returns highlighted snippets as plain segments around the match", async () => {
    const { items } = await searchArtifacts(db, owner, { q: "城市綠廊" });
    const snippet = items[0]!.snippet!;
    expect(snippet.segments.filter((segment) => segment.highlight).map((s) => s.text)).toEqual([
      "城市綠廊",
    ]);
    expect(snippet.segments.map((segment) => segment.text).join("")).toContain(
      "城市綠廊降低地表溫度",
    );
  });

  it("never shows another workspace's or a deleted artifact", async () => {
    const stranger = await createTestActor();
    expect(await titles(stranger, "城市")).toEqual([]);
    await importHtml(stranger, "theirs.html", "別人的研究", "城市綠廊也在這裡。");
    expect(await titles(owner, "城市綠廊")).toEqual(["都市研究甲"]);
    expect(await titles(stranger, "城市綠廊")).toEqual(["別人的研究"]);

    await db.update(artifacts).set({ deletedAt: new Date() }).where(eq(artifacts.id, adjacent));
    expect(await titles(owner, "城市綠廊")).toEqual([]);
    await db.update(artifacts).set({ deletedAt: null }).where(eq(artifacts.id, adjacent));
  });

  it("searches only the current version of an artifact", async () => {
    const actor = await createTestActor();
    await importHtml(actor, "versioned.html", "版本測試", "第一版提到海綿城市。");
    expect(await titles(actor, "海綿城市")).toEqual(["版本測試"]);
    await importHtml(actor, "versioned.html", "版本測試", "第二版改寫為透水鋪面。");
    expect(await titles(actor, "海綿城市")).toEqual([]);
    expect(await titles(actor, "透水鋪面")).toEqual(["版本測試"]);
  });

  it("backfills artifacts that have no index yet", async () => {
    const actor = await createTestActor();
    const id = await importHtml(actor, "backfill.html", "回填測試", "雨水花園的設計原則。");
    // As if imported before search existed.
    await db.delete(contentChunks).where(eq(contentChunks.artifactId, id));
    await db.delete(artifactSearchDocuments).where(eq(artifactSearchDocuments.artifactId, id));
    expect(await titles(actor, "雨水花園")).toEqual([]);
    expect(await enqueueMissingIndexes(db)).toBeGreaterThanOrEqual(1);
    await drainJobs();
    expect(await titles(actor, "雨水花園")).toEqual(["回填測試"]);
    // Nothing missing any more: a second pass queues nothing for it.
    expect(await enqueueMissingIndexes(db, new Date(Date.now() + 86_400_000))).toBe(0);
  });

  it("backfills a version whose own index job never ran, though its artifact has metadata", async () => {
    // E.g. the current version's job failed for good while another version's job wrote the
    // metadata document. Its text (no capital S) must still be indexed.
    const actor = await createTestActor();
    const id = await importHtml(actor, "partial.html", "部分索引", "屋頂綠化的維護成本。");
    await db.delete(contentChunks).where(eq(contentChunks.artifactId, id));
    const [current] = await db
      .select({ versionId: artifacts.currentVersionId })
      .from(artifacts)
      .where(eq(artifacts.id, id));
    await db
      .delete(searchIndexStates)
      .where(eq(searchIndexStates.artifactVersionId, current!.versionId!));
    expect(await titles(actor, "屋頂綠化")).toEqual([]);
    expect(await titles(actor, "部分索引")).toEqual(["部分索引"]);
    expect(
      await enqueueMissingIndexes(db, new Date(Date.now() + 2 * 86_400_000)),
    ).toBeGreaterThanOrEqual(1);
    await drainJobs();
    expect(await titles(actor, "屋頂綠化")).toEqual(["部分索引"]);
  });

  it("indexes the metadata of a version without any extraction", async () => {
    // A restored image whose archive had no text and whose re-extraction failed for good.
    const actor = await createTestActor();
    const id = await importHtml(actor, "no-text.html", "沒有文字的版本", "內文。");
    await db
      .update(artifactVersions)
      .set({ activeExtractionId: null })
      .where(eq(artifactVersions.artifactId, id));
    await db.delete(contentChunks).where(eq(contentChunks.artifactId, id));
    await db.delete(artifactSearchDocuments).where(eq(artifactSearchDocuments.artifactId, id));
    expect(await titles(actor, "沒有文字")).toEqual([]);
    expect(
      await enqueueMissingIndexes(db, new Date(Date.now() + 3 * 86_400_000)),
    ).toBeGreaterThanOrEqual(1);
    await drainJobs();
    expect(await titles(actor, "沒有文字")).toEqual(["沒有文字的版本"]);
  });

  it("builds the metadata document from the version that is current when it commits", async () => {
    const actor = await createTestActor();
    const id = await importHtml(actor, "metadata-race.html", "競態測試", "第一版。");
    await importHtml(actor, "metadata-race.html", "競態測試", "第二版。");
    const versions = await db
      .select({ id: artifactVersions.id, number: artifactVersions.versionNumber })
      .from(artifactVersions)
      .where(eq(artifactVersions.artifactId, id))
      .orderBy(artifactVersions.versionNumber);
    expect(versions).toHaveLength(2);
    const [v1, v2] = versions;
    await db
      .update(artifactVersions)
      .set({ author: "甲作者" })
      .where(eq(artifactVersions.id, v1!.id));
    await db
      .update(artifactVersions)
      .set({ author: "乙作者" })
      .where(eq(artifactVersions.id, v2!.id));
    await db.transaction((tx) => indexArtifactMetadata(tx, id));
    expect(await titles(actor, "乙作者")).toEqual(["競態測試"]);

    // Another transaction makes v1 current but has not committed yet. The metadata job must
    // wait for it, not build from v2 and overwrite what the commit makes true.
    let indexed: Promise<void> | undefined;
    await db.transaction(async (tx) => {
      await tx.update(artifacts).set({ currentVersionId: v1!.id }).where(eq(artifacts.id, id));
      indexed = db.transaction((other) => indexArtifactMetadata(other, id));
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    await indexed;
    expect(await titles(actor, "甲作者")).toEqual(["競態測試"]);
    expect(await titles(actor, "乙作者")).toEqual([]);
  });

  it("returns nothing for a query without searchable characters", async () => {
    expect(await searchArtifacts(db, owner, { q: "  ，。！ " })).toMatchObject({
      items: [],
      nextOffset: null,
    });
  });
});
