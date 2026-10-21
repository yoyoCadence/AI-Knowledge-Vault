import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "@/infrastructure/database/client";
import { artifacts, artifactTags, auditLogs, tags } from "@/infrastructure/database/schema";
import { AppError } from "@/lib/errors";
import { listArtifacts } from "@/modules/artifacts";
import type { Actor } from "@/modules/auth";
import { searchArtifacts } from "@/modules/search";
import {
  deleteTag,
  ensureTag,
  getArtifactTags,
  listTags,
  mergeTag,
  renameTag,
  setArtifactTag,
} from "@/modules/tags";
import { htmlDocument } from "@tests/fixtures/builders";
import { closeTestDb, testDb } from "../helpers/db";
import { createTestActor, drainJobs, newBatch, uploadFile } from "../helpers/imports";

const db = testDb();
const meta = { ipAddress: null, userAgent: "vitest" };

afterAll(async () => {
  await closeDb();
  await closeTestDb();
});

async function importHtml(actor: Actor, filename: string, title: string) {
  await uploadFile(actor, (await newBatch(actor)).id, {
    filename,
    bytes: htmlDocument({ title, body: `<p>${title}的內容。</p>` }),
  });
  await drainJobs();
  const [row] = await db
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(and(eq(artifacts.workspaceId, actor.workspaceId), eq(artifacts.title, title)));
  return row!.id;
}

const titles = async (actor: Actor, q: string, tagId?: string) =>
  (await searchArtifacts(db, actor, { q, tagId })).items.map((item) => item.title).sort();

const code = (error: unknown) => (error instanceof AppError ? error.code : String(error));

describe("tags (DATA_MODEL §4.4, API_CONTRACT §6)", () => {
  let owner: Actor;
  let stranger: Actor;
  let first: string;
  let second: string;

  beforeAll(async () => {
    owner = await createTestActor();
    stranger = await createTestActor();
    first = await importHtml(owner, "tag-first.html", "標籤測試甲");
    second = await importHtml(owner, "tag-second.html", "標籤測試乙");
  });

  it("creates a tag once per normalized name", async () => {
    const created = await ensureTag(db, owner, "ＡＩ 模型", meta);
    expect(created.created).toBe(true);
    expect(created.tag.name).toBe("ＡＩ 模型");
    const again = await ensureTag(db, owner, "  ai   模型 ", meta);
    expect(again).toEqual({ tag: created.tag, created: false });
    // Another workspace has its own namespace.
    const theirs = await ensureTag(db, stranger, "ai 模型", meta);
    expect(theirs.created).toBe(true);
    expect(theirs.tag.id).not.toBe(created.tag.id);
  });

  it("tags and untags an artifact idempotently, and search finds it by tag name", async () => {
    const { tag } = await ensureTag(db, owner, "熱島專題", meta);
    expect(await titles(owner, "熱島專題")).toEqual([]);
    const add = () =>
      setArtifactTag(db, owner, { artifactId: first, tagId: tag.id, present: true }, meta);
    expect(await add()).toEqual([{ id: tag.id, name: "熱島專題" }]);
    expect(await add()).toEqual([{ id: tag.id, name: "熱島專題" }]);
    expect(await titles(owner, "熱島專題")).toEqual(["標籤測試甲"]);
    expect(await getArtifactTags(db, owner, first)).toEqual([{ id: tag.id, name: "熱島專題" }]);

    const remove = () =>
      setArtifactTag(db, owner, { artifactId: first, tagId: tag.id, present: false }, meta);
    expect(await remove()).toEqual([]);
    expect(await remove()).toEqual([]);
    expect(await titles(owner, "熱島專題")).toEqual([]);
  });

  it("never links across workspaces or to deleted artifacts", async () => {
    const mine = (await ensureTag(db, owner, "私人", meta)).tag;
    const theirs = (await ensureTag(db, stranger, "別人的", meta)).tag;
    await expect(
      setArtifactTag(db, stranger, { artifactId: first, tagId: theirs.id, present: true }, meta),
    ).rejects.toSatisfy((error) => code(error) === "NOT_FOUND");
    await expect(
      setArtifactTag(db, owner, { artifactId: first, tagId: theirs.id, present: true }, meta),
    ).rejects.toSatisfy((error) => code(error) === "NOT_FOUND");
    await expect(renameTag(db, stranger, mine.id, "改名", meta)).rejects.toSatisfy(
      (error) => code(error) === "NOT_FOUND",
    );
    await expect(deleteTag(db, stranger, mine.id, meta)).rejects.toSatisfy(
      (error) => code(error) === "NOT_FOUND",
    );
    await expect(mergeTag(db, owner, mine.id, theirs.id, meta)).rejects.toSatisfy(
      (error) => code(error) === "NOT_FOUND",
    );

    // The database refuses a cross-workspace link even if code forgot to check.
    await expect(
      db.insert(artifactTags).values({
        workspaceId: owner.workspaceId,
        artifactId: first,
        tagId: theirs.id,
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(artifactTags).values({
        workspaceId: stranger.workspaceId,
        artifactId: first,
        tagId: theirs.id,
      }),
    ).rejects.toThrow();

    await db.update(artifacts).set({ deletedAt: new Date() }).where(eq(artifacts.id, second));
    await expect(
      setArtifactTag(db, owner, { artifactId: second, tagId: mine.id, present: true }, meta),
    ).rejects.toSatisfy((error) => code(error) === "NOT_FOUND");
    await db.update(artifacts).set({ deletedAt: null }).where(eq(artifacts.id, second));
  });

  it("renames a tag and re-indexes its artifacts; a taken name is a conflict", async () => {
    const tag = (await ensureTag(db, owner, "舊名稱", meta)).tag;
    const other = (await ensureTag(db, owner, "另一個", meta)).tag;
    await setArtifactTag(db, owner, { artifactId: first, tagId: tag.id, present: true }, meta);
    expect(await titles(owner, "舊名稱")).toEqual(["標籤測試甲"]);

    expect(await renameTag(db, owner, tag.id, "新名稱", meta)).toEqual({
      id: tag.id,
      name: "新名稱",
    });
    expect(await titles(owner, "舊名稱")).toEqual([]);
    expect(await titles(owner, "新名稱")).toEqual(["標籤測試甲"]);

    await expect(renameTag(db, owner, tag.id, " 另一個 ", meta)).rejects.toSatisfy(
      (error) =>
        error instanceof AppError && error.code === "CONFLICT" && error.details?.tagId === other.id,
    );
    // Changing only the display form (same identity) is a rename, not a conflict.
    expect((await renameTag(db, owner, tag.id, "新　名稱", meta)).name).toBe("新 名稱");
  });

  it("merges a tag into another: artifacts move, the source disappears, search follows", async () => {
    const source = (await ensureTag(db, owner, "合併來源", meta)).tag;
    const into = (await ensureTag(db, owner, "合併目標", meta)).tag;
    await setArtifactTag(db, owner, { artifactId: first, tagId: source.id, present: true }, meta);
    await setArtifactTag(db, owner, { artifactId: second, tagId: source.id, present: true }, meta);
    // `first` already has the target: the merge must not fail on the duplicate.
    await setArtifactTag(db, owner, { artifactId: first, tagId: into.id, present: true }, meta);

    await expect(mergeTag(db, owner, into.id, into.id, meta)).rejects.toSatisfy(
      (error) => code(error) === "VALIDATION_FAILED",
    );
    expect(await mergeTag(db, owner, source.id, into.id, meta)).toEqual(into);
    expect(await db.select().from(tags).where(eq(tags.id, source.id))).toEqual([]);
    expect(await titles(owner, "合併來源")).toEqual([]);
    expect(await titles(owner, "合併目標")).toEqual(["標籤測試乙", "標籤測試甲"]);
  });

  it("deletes a tag from every artifact and from search", async () => {
    const tag = (await ensureTag(db, owner, "即將刪除", meta)).tag;
    await setArtifactTag(db, owner, { artifactId: second, tagId: tag.id, present: true }, meta);
    expect(await titles(owner, "即將刪除")).toEqual(["標籤測試乙"]);
    await deleteTag(db, owner, tag.id, meta);
    expect(await getArtifactTags(db, owner, second)).not.toContainEqual(
      expect.objectContaining({ id: tag.id }),
    );
    expect(await titles(owner, "即將刪除")).toEqual([]);
  });

  it("lists tags with counts that leave out deleted artifacts", async () => {
    const tag = (await ensureTag(db, owner, "計數", meta)).tag;
    for (const artifactId of [first, second])
      await setArtifactTag(db, owner, { artifactId, tagId: tag.id, present: true }, meta);
    const count = async () =>
      (await listTags(db, owner)).find((row) => row.id === tag.id)?.artifactCount;
    expect(await count()).toBe(2);
    await db.update(artifacts).set({ deletedAt: new Date() }).where(eq(artifacts.id, second));
    expect(await count()).toBe(1);
    await db.update(artifacts).set({ deletedAt: null }).where(eq(artifacts.id, second));
    expect((await listTags(db, stranger)).map((row) => row.id)).not.toContain(tag.id);
  });

  it("filters search and the library list by tag", async () => {
    const tag = (await ensureTag(db, owner, "篩選", meta)).tag;
    await setArtifactTag(db, owner, { artifactId: second, tagId: tag.id, present: true }, meta);
    expect(await titles(owner, "標籤測試")).toEqual(["標籤測試乙", "標籤測試甲"]);
    expect(await titles(owner, "標籤測試", tag.id)).toEqual(["標籤測試乙"]);

    const listed = await listArtifacts(db, owner, { limit: 50, tagId: tag.id });
    expect(listed.items.map((item) => item.id)).toEqual([second]);
    expect(listed.items[0]!.tags.map((itemTag) => itemTag.name)).toContain("篩選");
    // Another workspace's tag id filters to nothing, never to someone else's artifacts.
    expect((await listArtifacts(db, stranger, { limit: 50, tagId: tag.id })).items).toEqual([]);
    expect(await titles(stranger, "標籤測試", tag.id)).toEqual([]);
  });

  it("audits tag changes by id only, never by name", async () => {
    const tag = (await ensureTag(db, owner, "稽核用的名字", meta)).tag;
    await setArtifactTag(db, owner, { artifactId: first, tagId: tag.id, present: true }, meta);
    const events = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.workspaceId, owner.workspaceId));
    const actions = events.map((event) => event.action);
    expect(actions).toEqual(expect.arrayContaining(["tag.created", "artifact.tag_added"]));
    expect(JSON.stringify(events)).not.toContain("稽核用的名字");
  });

  it("refuses invalid names", async () => {
    for (const bad of ["", "   ", "x".repeat(51)]) {
      await expect(ensureTag(db, owner, bad, meta), bad).rejects.toSatisfy(
        (error) => code(error) === "VALIDATION_FAILED",
      );
    }
  });
});
