import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { GET as contentRoute } from "@/app/api/artifacts/[id]/versions/[versionId]/content/route";
import { getEnv } from "@/infrastructure/config/env";
import { closeDb } from "@/infrastructure/database/client";
import { artifactVersions } from "@/infrastructure/database/schema";
import { newId } from "@/lib/ids";
import { htmlDocument, markdownDocument, pngImage } from "@tests/fixtures/builders";
import { createTestAdmin, signIn } from "../helpers/auth";
import { closeTestDb, testDb } from "../helpers/db";
import { drainJobs, newBatch, uploadFile } from "../helpers/imports";

const db = testDb();
const env = getEnv();

afterAll(async () => {
  await closeDb();
  await closeTestDb();
});

async function loggedIn() {
  const admin = await createTestAdmin();
  const { cookie } = await signIn(admin.email, admin.password);
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

async function importOne(owner: Owner, filename: string, bytes: Buffer | string) {
  const item = await uploadFile(owner.actor, (await newBatch(owner.actor)).id, {
    filename,
    bytes,
  });
  await drainJobs();
  const [version] = await db
    .select({ id: artifactVersions.id, artifactId: artifactVersions.artifactId })
    .from(artifactVersions)
    .where(eq(artifactVersions.importItemId, item.id));
  return { artifactId: version!.artifactId, versionId: version!.id };
}

const content = (cookie: string, ids: { artifactId: string; versionId: string }) =>
  contentRoute(
    new Request(
      `${env.APP_ORIGIN}/api/artifacts/${ids.artifactId}/versions/${ids.versionId}/content`,
      { headers: { cookie } },
    ),
    { params: Promise.resolve({ id: ids.artifactId, versionId: ids.versionId }) },
  );

type ContentDto = {
  contentKind: string;
  extraction: { method: string; status: string; markdown: string; title: string | null };
  sections: { ordinal: number; heading: string | null; anchor: string }[];
};

describe("reading-mode content API (FR-LIB-4)", () => {
  it("returns the normalized Markdown and sections of the owner's version", async () => {
    const owner = await loggedIn();
    const note = await importOne(owner, "reading.html", htmlDocument({ title: "閱讀測試" }));
    const response = await content(owner.cookie, note);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ContentDto;
    expect(body.extraction.method).toBe("html");
    expect(body.extraction.markdown).toContain("## 位置資訊");
    // Imported HTML never reaches reading mode as HTML: scripts and hidden text are gone.
    expect(body.extraction.markdown).not.toMatch(/<script|tracking|隱藏內容/);
    expect(body.sections.map((section) => section.heading)).toContain("位置資訊");
    expect(body.sections.every((section) => /^[\p{L}\p{N}-]+$/u.test(section.anchor))).toBe(true);
  });

  it("serves Markdown and plain-text versions with their method", async () => {
    const owner = await loggedIn();
    const md = await importOne(owner, "notes.md", markdownDocument());
    expect(((await (await content(owner.cookie, md)).json()) as ContentDto).extraction.method).toBe(
      "markdown",
    );
    const txt = await importOne(owner, "plain.txt", "# not a heading\n<b>kept as text</b>\n");
    const body = (await (await content(owner.cookie, txt)).json()) as ContentDto;
    expect(body.extraction.method).toBe("text");
    expect(body.extraction.markdown).toContain("<b>kept as text</b>");
  });

  it("is 404 for other workspaces and unknown versions; 401 without a session", async () => {
    const owner = await loggedIn();
    const note = await importOne(owner, "mine.html", htmlDocument({ title: "私人" }));
    const stranger = await loggedIn();
    expect((await content(stranger.cookie, note)).status).toBe(404);
    expect((await content(owner.cookie, { ...note, versionId: newId() })).status).toBe(404);
    expect((await content("", note)).status).toBe(401);
    // An image has an extraction record without text; the page shows its thumbnail instead.
    const image = await importOne(owner, "photo.png", await pngImage());
    const imageBody = (await (await content(owner.cookie, image)).json()) as ContentDto;
    expect(imageBody.contentKind).toBe("image");
    expect(imageBody.extraction.markdown).toBe("");
  });
});
