import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "@/infrastructure/database/client";
import { artifacts, artifactVersions } from "@/infrastructure/database/schema";
import { AppError } from "@/lib/errors";
import { listArtifacts, listSourceModels, updateArtifact } from "@/modules/artifacts";
import type { Actor } from "@/modules/auth";
import {
  createProject,
  deleteProject,
  findProject,
  listProjects,
  updateProject,
} from "@/modules/projects";
import { searchArtifacts } from "@/modules/search";
import { htmlDocument, markdownDocument } from "@tests/fixtures/builders";
import { closeTestDb, testDb } from "../helpers/db";
import { createTestActor, drainJobs, newBatch, uploadFile } from "../helpers/imports";

const db = testDb();
const meta = { ipAddress: null, userAgent: "vitest" };
const code = (error: unknown) => (error instanceof AppError ? error.code : String(error));

afterAll(async () => {
  await closeDb();
  await closeTestDb();
});

async function importFile(actor: Actor, filename: string, bytes: string, title: string) {
  await uploadFile(actor, (await newBatch(actor)).id, { filename, bytes });
  await drainJobs();
  const [row] = await db
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(and(eq(artifacts.workspaceId, actor.workspaceId), eq(artifacts.title, title)));
  return row!.id;
}

const searchTitles = async (actor: Actor, q: string, extra: object = {}) =>
  (await searchArtifacts(db, actor, { q, ...extra })).items.map((item) => item.title);

describe("research projects (API_CONTRACT §6)", () => {
  let owner: Actor;
  let stranger: Actor;

  beforeAll(async () => {
    owner = await createTestActor();
    stranger = await createTestActor();
  });

  it("creates, lists with counts, renames, archives and soft-deletes projects", async () => {
    const project = await createProject(
      db,
      owner,
      { title: "  城市 熱島  ", description: "" },
      meta,
    );
    expect(project).toMatchObject({ title: "城市 熱島", description: null, status: "active" });
    const updated = await updateProject(
      db,
      owner,
      project.id,
      { title: "都市熱島", description: "夏季觀測", status: "archived" },
      meta,
    );
    expect(updated).toMatchObject({
      title: "都市熱島",
      description: "夏季觀測",
      status: "archived",
    });
    expect((await listProjects(db, owner)).map((row) => row.id)).toContain(project.id);
    expect(await listProjects(db, stranger)).toEqual([]);

    await expect(updateProject(db, stranger, project.id, { title: "x" }, meta)).rejects.toSatisfy(
      (error) => code(error) === "NOT_FOUND",
    );
    await expect(deleteProject(db, stranger, project.id, meta)).rejects.toSatisfy(
      (error) => code(error) === "NOT_FOUND",
    );
    await deleteProject(db, owner, project.id, meta);
    expect(await findProject(db, owner, project.id)).toBeNull();
    expect((await listProjects(db, owner)).map((row) => row.id)).not.toContain(project.id);
    await expect(deleteProject(db, owner, project.id, meta)).rejects.toSatisfy(
      (error) => code(error) === "NOT_FOUND",
    );

    for (const title of ["", "   ", "x".repeat(201)]) {
      await expect(createProject(db, owner, { title }, meta), title).rejects.toSatisfy(
        (error) => code(error) === "VALIDATION_FAILED",
      );
    }
    await expect(updateProject(db, owner, project.id, {}, meta)).rejects.toSatisfy(
      (error) => code(error) === "VALIDATION_FAILED",
    );
    // Same text rules as artifacts: no invisible or spoofed titles, no control characters.
    for (const input of [
      { title: "\u200b" },
      { title: "abc\u202eexe.gpj" },
      { title: "ok", description: "a\u0000b" },
      { title: "ok", description: "a\u0007\u001bb" },
      { title: "ok", description: "a\u0085b" },
      { title: "ok", description: "a\ud800b" },
    ]) {
      await expect(createProject(db, owner, input, meta), JSON.stringify(input)).rejects.toSatisfy(
        (error) => code(error) === "VALIDATION_FAILED",
      );
    }
    expect(
      (await createProject(db, owner, { title: "多行", description: "第一行\r\n第二行" }, meta))
        .description,
    ).toBe("第一行\n第二行");
  });

  it("counts only the workspace's own artifacts, even if a reference crosses workspaces", async () => {
    const project = await createProject(db, owner, { title: "跨工作區計數" }, meta);
    const foreign = await importFile(
      stranger,
      "foreign-member.html",
      htmlDocument({ title: "他人文件" }),
      "他人文件",
    );
    // The API never allows this (the project must be in the actor's workspace); only a direct
    // database write can create it, and it must not show up in the owner's count.
    await db.update(artifacts).set({ projectId: project.id }).where(eq(artifacts.id, foreign));
    const row = (await listProjects(db, owner)).find((item) => item.id === project.id);
    expect(row?.artifactCount).toBe(0);
    expect(
      (await listArtifacts(db, owner, { limit: 50, filters: { projectId: project.id } })).items,
    ).toEqual([]);
  });

  it("puts artifacts in a project, counts them and filters by it", async () => {
    const project = await createProject(db, owner, { title: "綠建築" }, meta);
    const id = await importFile(
      owner,
      "project-member.html",
      htmlDocument({ title: "屋頂綠化" }),
      "屋頂綠化",
    );
    const other = await importFile(
      owner,
      "project-outsider.html",
      htmlDocument({ title: "雨水回收" }),
      "雨水回收",
    );
    expect(await updateArtifact(db, owner, id, { projectId: project.id }, meta)).toMatchObject({
      projectId: project.id,
    });

    const count = async () =>
      (await listProjects(db, owner)).find((row) => row.id === project.id)?.artifactCount;
    expect(await count()).toBe(1);
    const listed = await listArtifacts(db, owner, {
      limit: 50,
      filters: { projectId: project.id },
    });
    expect(listed.items.map((item) => item.id)).toEqual([id]);
    expect(await searchTitles(owner, "都市熱島 OR 屋頂", {})).toEqual([]); // no such words
    expect(await searchTitles(owner, "屋頂綠化", { filters: { projectId: project.id } })).toEqual([
      "屋頂綠化",
    ]);
    expect(await searchTitles(owner, "雨水回收", { filters: { projectId: project.id } })).toEqual(
      [],
    );
    expect(other).toBeTruthy();

    // Another workspace's project, a deleted one, or one that does not exist: 404.
    const theirs = await createProject(db, stranger, { title: "他們的專案" }, meta);
    await expect(updateArtifact(db, owner, id, { projectId: theirs.id }, meta)).rejects.toSatisfy(
      (error) => code(error) === "NOT_FOUND",
    );
    await expect(
      updateArtifact(db, stranger, id, { projectId: theirs.id }, meta),
    ).rejects.toSatisfy((error) => code(error) === "NOT_FOUND");

    // Deleting the project keeps the artifact and its reference, but filters to nothing.
    await deleteProject(db, owner, project.id, meta);
    expect(
      (await listArtifacts(db, owner, { limit: 50, filters: { projectId: project.id } })).items,
    ).toEqual([]);
    const [row] = await db.select().from(artifacts).where(eq(artifacts.id, id));
    expect(row!.projectId).toBe(project.id);
    // Editing something else does not reveal the deleted project's id.
    expect((await updateArtifact(db, owner, id, { title: "屋頂綠化" }, meta)).projectId).toBeNull();
    await expect(updateArtifact(db, owner, id, { projectId: project.id }, meta)).rejects.toSatisfy(
      (error) => code(error) === "NOT_FOUND",
    );
    expect(await updateArtifact(db, owner, id, { projectId: null }, meta)).toMatchObject({
      projectId: null,
    });
  });

  it("edits title and description, and search follows", async () => {
    const id = await importFile(
      owner,
      "rename-me.html",
      htmlDocument({ title: "舊的標題" }),
      "舊的標題",
    );
    // The new title and the description appear nowhere in the body: only the re-indexed
    // metadata can find them.
    await updateArtifact(
      db,
      owner,
      id,
      { title: "  新的　名字 ", description: "談透水鋪面\n與植栽" },
      meta,
    );
    expect(await searchTitles(owner, "新的名字")).toEqual([]);
    expect(await searchTitles(owner, '"新的 名字"')).toEqual(["新的 名字"]);
    expect(await searchTitles(owner, "透水鋪面")).toEqual(["新的 名字"]);
    await updateArtifact(db, owner, id, { description: null }, meta);
    expect(await searchTitles(owner, "透水鋪面")).toEqual([]);
    for (const edit of [
      { title: "\u200b" },
      { title: "abc\u202eexe.gpj" },
      { description: "a\u0085b" },

      { title: "" },
      { title: "x".repeat(501) },
      { description: "a\u0007b" },
      {},
    ]) {
      await expect(
        updateArtifact(db, owner, id, edit, meta),
        JSON.stringify(edit),
      ).rejects.toSatisfy((error) => code(error) === "VALIDATION_FAILED");
    }
    await expect(updateArtifact(db, stranger, id, { title: "偷改" }, meta)).rejects.toSatisfy(
      (error) => code(error) === "NOT_FOUND",
    );
  });
});

describe("library filters and sort (FR-SRCH-3)", () => {
  let actor: Actor;
  let html: string;
  let markdown: string;

  beforeAll(async () => {
    actor = await createTestActor();
    html = await importFile(
      actor,
      "filter-html.html",
      htmlDocument({ title: "篩選網頁" }),
      "篩選網頁",
    );
    markdown = await importFile(
      actor,
      "filter-notes.md",
      markdownDocument().replaceAll("量化交易研究摘要", "篩選筆記"),
      "篩選筆記",
    );
    // Known dates and models (as if imported on different days from different tools).
    await db
      .update(artifacts)
      .set({ createdAt: new Date("2026-01-10T02:00:00Z") })
      .where(eq(artifacts.id, html));
    await db
      .update(artifacts)
      .set({ createdAt: new Date("2026-03-05T15:30:00Z") }) // 2026-03-05 23:30 in Taipei
      .where(eq(artifacts.id, markdown));
    await db
      .update(artifactVersions)
      .set({ sourceModel: "GPT-5" })
      .where(eq(artifactVersions.artifactId, html));
  });

  const ids = async (filters: object, sort?: "newest" | "oldest") =>
    (await listArtifacts(db, actor, { limit: 50, filters, sort })).items.map((item) => item.id);

  it("filters the library by kind, source model and import day (Taipei time)", async () => {
    expect(await ids({ kind: "markdown" })).toEqual([markdown]);
    expect(await ids({ sourceModel: "GPT-5" })).toEqual([html]);
    expect(await ids({ sourceModel: "example-model-1" })).toEqual([markdown]); // front matter
    // A model recorded with spaces is offered as is, and filters as is.
    await db
      .update(artifactVersions)
      .set({ sourceModel: "  gpt-ws  " })
      .where(eq(artifactVersions.artifactId, html));
    expect(await listSourceModels(db, actor)).toContain("  gpt-ws  ");
    expect(await ids({ sourceModel: "  gpt-ws  " })).toEqual([html]);
    await db
      .update(artifactVersions)
      .set({ sourceModel: "GPT-5" })
      .where(eq(artifactVersions.artifactId, html));
    expect(await ids({ from: "2026-03-05" })).toEqual([markdown]);
    expect(await ids({ to: "2026-03-05" })).toEqual([markdown, html]);
    expect(await ids({ to: "2026-03-04" })).toEqual([html]);
    expect(await ids({ from: "2026-01-10", to: "2026-01-10" })).toEqual([html]);
    expect([...(await listSourceModels(db, actor))].sort()).toEqual(
      ["GPT-5", "example-model-1"].sort(),
    );
  });

  it("sorts newest or oldest first, with a cursor that continues in that order", async () => {
    expect(await ids({})).toEqual([markdown, html]);
    expect(await ids({}, "oldest")).toEqual([html, markdown]);
    const first = await listArtifacts(db, actor, { limit: 1, sort: "oldest" });
    expect(first.items.map((item) => item.id)).toEqual([html]);
    const next = await listArtifacts(db, actor, {
      limit: 1,
      sort: "oldest",
      cursor: first.nextCursor!,
    });
    expect(next.items.map((item) => item.id)).toEqual([markdown]);
  });

  it("filters, sorts and counts search results", async () => {
    const all = await searchArtifacts(db, actor, { q: "篩選" });
    expect(all.total).toBe(2);
    const filtered = await searchArtifacts(db, actor, {
      q: "篩選",
      filters: { kind: "html_document" },
    });
    expect(filtered.items.map((item) => item.id)).toEqual([html]);
    expect(filtered.total).toBe(1);
    // The older artifact becomes the more relevant one: relevance and newest must disagree.
    await updateArtifact(db, actor, html, { description: "篩選篩選篩選，關於篩選。" }, meta);
    const order = async (sort?: "relevance" | "newest") =>
      (await searchArtifacts(db, actor, { q: "篩選", sort })).items.map((item) => item.id);
    expect(await order("relevance")).toEqual([html, markdown]);
    expect(await order()).toEqual([html, markdown]);
    expect(await order("newest")).toEqual([markdown, html]);
    expect(
      (await searchArtifacts(db, actor, { q: "篩選", sort: "title" })).items.map(
        (item) => item.title,
      ),
    ).toEqual(["篩選筆記", "篩選網頁"].sort());
    expect((await searchArtifacts(db, actor, { q: "篩選", offset: 40 })).total).toBeNull();
  });
});
