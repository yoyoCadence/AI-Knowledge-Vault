import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PATCH as patchVersionRoute } from "@/app/api/artifacts/[id]/versions/[versionId]/route";
import { GET as searchRoute } from "@/app/api/search/route";
import { getEnv } from "@/infrastructure/config/env";
import { closeDb } from "@/infrastructure/database/client";
import {
  artifacts,
  artifactVersions,
  auditLogs,
  workspaceMembers,
} from "@/infrastructure/database/schema";
import { newId } from "@/lib/ids";
import { htmlDocument } from "@tests/fixtures/builders";
import { createTestAdmin, signInOk } from "../helpers/auth";
import { closeTestDb, testDb } from "../helpers/db";
import { drainJobs, newBatch, uploadFile } from "../helpers/imports";

const db = testDb();
const env = getEnv();

afterAll(async () => {
  await closeDb();
  await closeTestDb();
});

const params = <T>(value: T) => ({ params: Promise.resolve(value) });

async function loggedIn() {
  const admin = await createTestAdmin();
  const { cookie } = await signInOk(admin.email, admin.password);
  const actor = {
    userId: admin.userId,
    workspaceId: admin.workspaceId,
    role: "owner" as const,
    sessionId: newId(),
    email: admin.email,
    name: "Owner",
  };
  return { ...admin, cookie, actor };
}

type Owner = Awaited<ReturnType<typeof loggedIn>>;

async function importOne(owner: Owner, filename: string, title: string, targetArtifactId?: string) {
  const item = await uploadFile(owner.actor, (await newBatch(owner.actor)).id, {
    filename,
    bytes: htmlDocument({ title, body: `<p>${title}的內容。</p>` }),
    targetArtifactId,
  });
  await drainJobs();
  const [version] = await db
    .select({ id: artifactVersions.id, artifactId: artifactVersions.artifactId })
    .from(artifactVersions)
    .where(eq(artifactVersions.importItemId, item.id));
  return { artifactId: version!.artifactId, versionId: version!.id };
}

interface Source {
  sourcePlatform: string | null;
  sourceModel: string | null;
  researchDate: string | null;
  author: string | null;
  sourceUrl: string | null;
}

describe("PATCH /api/artifacts/:id/versions/:versionId (source metadata)", () => {
  let owner: Owner;
  let target: { artifactId: string; versionId: string };

  beforeAll(async () => {
    owner = await loggedIn();
    target = await importOne(owner, "source.html", "來源編輯測試");
  });

  const patch = (
    body: unknown,
    cookie = owner.cookie,
    ids: { artifactId: string; versionId: string } = target,
  ) =>
    patchVersionRoute(
      new Request(`${env.APP_ORIGIN}/api/artifacts/${ids.artifactId}/versions/${ids.versionId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie, origin: env.APP_ORIGIN },
        body: JSON.stringify(body),
      }),
      params({ id: ids.artifactId, versionId: ids.versionId }),
    );
  const stored = async (versionId = target.versionId) => {
    const [row] = await db
      .select({
        sourcePlatform: artifactVersions.sourcePlatform,
        sourceModel: artifactVersions.sourceModel,
        researchDate: artifactVersions.researchDate,
        author: artifactVersions.author,
        sourceUrl: artifactVersions.sourceUrl,
      })
      .from(artifactVersions)
      .where(eq(artifactVersions.id, versionId));
    return row!;
  };

  it("edits, cleans and clears the fields, audited, and search follows", async () => {
    const response = await patch({
      sourcePlatform: "chatgpt",
      sourceModel: "  瀚海模型   X1 ",
      researchDate: "2024-02-29",
      author: "研究\u200f者",
      sourceUrl: "https://example.org/研究?q=1",
    });
    expect(response.status).toBe(200);
    const { version } = (await response.json()) as { version: Source & { id: string } };
    expect(version).toEqual({
      id: target.versionId,
      sourcePlatform: "chatgpt",
      sourceModel: "瀚海模型 X1",
      researchDate: "2024-02-29",
      author: "研究者",
      sourceUrl: "https://example.org/%E7%A0%94%E7%A9%B6?q=1",
    });
    expect(await stored()).toEqual({
      sourcePlatform: "chatgpt",
      sourceModel: "瀚海模型 X1",
      researchDate: "2024-02-29",
      author: "研究者",
      sourceUrl: "https://example.org/%E7%A0%94%E7%A9%B6?q=1",
    });

    // The current version's source is search metadata: it is found right away.
    const searched = (await (
      await searchRoute(
        new Request(`${env.APP_ORIGIN}/api/search?q=${encodeURIComponent("瀚海模型")}`, {
          headers: { cookie: owner.cookie },
        }),
        params({}),
      )
    ).json()) as { items: { id: string }[] };
    expect(searched.items.map((item) => item.id)).toEqual([target.artifactId]);

    const [audit] = await db
      .select({ metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "artifact_version.updated"),
          eq(auditLogs.targetId, target.versionId),
        ),
      );
    expect(audit!.metadata).toEqual({
      artifactId: target.artifactId,
      fields: ["sourcePlatform", "sourceModel", "author", "researchDate", "sourceUrl"],
    });

    // Only what is sent changes; empty and null clear.
    expect((await patch({ author: "", sourceUrl: null })).status).toBe(200);
    expect(await stored()).toMatchObject({
      sourceModel: "瀚海模型 X1",
      author: null,
      sourceUrl: null,
    });
  });

  it("refuses what is not clean text, a real day or an http(s) link", async () => {
    for (const body of [
      {},
      { sourceModel: "x", extra: 1 },
      { sourcePlatform: "p".repeat(101) },
      { sourceModel: "m".repeat(201) },
      { author: "a\u0007b" },
      { author: "\u200b\u200b" },
      { researchDate: "2023-02-29" },
      { researchDate: "2024-1-5" },
      { researchDate: "0000-12-31" },
      { researchDate: "tomorrow" },
      { sourceUrl: "javascript:alert(1)" },
      { sourceUrl: "ftp://example.org/a" },
      { sourceUrl: "https://user:pass@example.org/" },
      { sourceUrl: "/relative/path" },
      { sourceUrl: `https://example.org/${"a".repeat(2_048)}` },
      { sourceModel: 42 },
    ]) {
      const response = await patch(body);
      expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
  });

  it("edits older versions too, and nothing outside the artifact or workspace", async () => {
    const second = await importOne(owner, "source-v2.html", "來源編輯測試 v2", target.artifactId);
    expect(second.artifactId).toBe(target.artifactId);
    expect((await patch({ author: "舊版作者" })).status).toBe(200);
    expect((await stored()).author).toBe("舊版作者");
    // Search describes the current version: an older version's source is not found.
    const searched = (await (
      await searchRoute(
        new Request(`${env.APP_ORIGIN}/api/search?q=${encodeURIComponent("舊版作者")}`, {
          headers: { cookie: owner.cookie },
        }),
        params({}),
      )
    ).json()) as { items: { id: string }[] };
    expect(searched.items).toEqual([]);

    const other = await importOne(owner, "other.html", "另一份作品");
    expect(
      (await patch({ author: "x" }, owner.cookie, { ...target, versionId: other.versionId }))
        .status,
    ).toBe(404);
    expect(
      (await patch({ author: "x" }, owner.cookie, { ...target, versionId: "nope" })).status,
    ).toBe(404);

    const stranger = await loggedIn();
    expect((await patch({ author: "闖入" }, stranger.cookie)).status).toBe(404);
    const viewer = await loggedIn();
    await db
      .update(workspaceMembers)
      .set({ workspaceId: owner.workspaceId, role: "viewer" })
      .where(eq(workspaceMembers.userId, viewer.userId));
    expect((await patch({ author: "檢視者" }, viewer.cookie)).status).toBe(403);

    await db
      .update(artifacts)
      .set({ deletedAt: new Date() })
      .where(eq(artifacts.id, other.artifactId));
    expect((await patch({ author: "x" }, owner.cookie, other)).status).toBe(404);
    expect((await stored()).author).toBe("舊版作者");
  });
});
