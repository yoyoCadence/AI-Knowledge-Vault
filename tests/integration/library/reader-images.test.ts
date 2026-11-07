import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { GET as previewRoute } from "@/app/p/[token]/[...path]/route";
import { getEnv } from "@/infrastructure/config/env";
import { closeDb } from "@/infrastructure/database/client";
import { artifactVersions } from "@/infrastructure/database/schema";
import { readerImageSrc } from "@/lib/reader-images";
import { getVersionContent } from "@/modules/artifacts";
import { issuePreviewUrl, readerImagesFor } from "@/modules/preview";
import { pngImage } from "@tests/fixtures/builders";
import { buildZip } from "@tests/fixtures/zip";
import { closeTestDb, testDb } from "../helpers/db";
import { createTestActor, drainJobs, newBatch, uploadFile } from "../helpers/imports";

/**
 * Reading mode's images from a real static-site import: the version's image files are listed
 * (nothing else of the bundle), the URL reading mode builds is one the preview route serves,
 * and nothing is listed without a preview, or for another workspace.
 */

const db = testDb();
const env = getEnv();

afterAll(async () => {
  await closeDb();
  await closeTestDb();
});

describe("reading mode images (readerImagesFor)", () => {
  it("lists a bundle's image files and builds URLs the preview origin serves", async () => {
    const actor = await createTestActor();
    const pixel =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const zip = buildZip([
      {
        name: "site/index.html",
        data: `<!doctype html><html lang="zh-Hant"><head><title>圖片報告</title>
<link rel="stylesheet" href="styles.css"></head><body><h1>圖片報告</h1>
<p>長條圖如下。</p><img src="img/chart.png" alt="長條圖">
<img src="data:image/png;base64,${pixel}" alt="內嵌圖">
<img src="https://tracker.example/pixel.png" alt="外部圖"></body></html>`,
      },
      { name: "site/styles.css", data: "body { color: #333 }" },
      { name: "site/img/chart.png", data: await pngImage(40, 20) },
    ]);
    const item = await uploadFile(actor, (await newBatch(actor)).id, {
      filename: "image-report.zip",
      bytes: zip,
    });
    await drainJobs();
    const [version] = await db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.importItemId, item.id));
    expect(version).toMatchObject({ previewKind: "static_site", previewStatus: "ready" });
    const target = { versionId: version!.id, workspaceId: actor.workspaceId };

    const preview = await issuePreviewUrl(
      db,
      actor,
      { artifactId: version!.artifactId, versionId: version!.id },
      env,
    );
    expect(preview).not.toBeNull();
    const images = await readerImagesFor(db, target, preview, version!.previewEntryPath);
    expect(images.files).toEqual(["img/chart.png"]);
    expect(images.previewBase).toMatch(new RegExp(`^${env.PREVIEW_ORIGIN}/p/[^/]+/$`));

    // The stored Markdown keeps the image URLs; reading mode resolves exactly the bundle's one.
    const content = await getVersionContent(db, actor, version!.artifactId, version!.id);
    const urls = [...content!.extraction.markdown.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map(
      (match) => match[1]!,
    );
    expect(urls).toEqual([
      "img/chart.png",
      `data:image/png;base64,${pixel}`,
      "https://tracker.example/pixel.png",
    ]);
    const src = readerImageSrc(urls[0]!, images)!;
    expect(src).toBe(`${images.previewBase}img/chart.png`);
    expect(readerImageSrc(urls[2]!, images)).toBeNull();

    const served = await previewRoute(new Request(src, { headers: { host: new URL(src).host } }));
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(
      Buffer.from(await served.arrayBuffer())
        .subarray(1, 4)
        .toString(),
    ).toBe("PNG");

    // No preview, no bundle images (data: ones still show); another workspace sees no files.
    expect(await readerImagesFor(db, target, null, version!.previewEntryPath)).toEqual({
      previewBase: null,
      entryPath: null,
      files: [],
    });
    const stranger = await createTestActor();
    expect(
      (await readerImagesFor(db, { ...target, workspaceId: stranger.workspaceId }, preview, null))
        .files,
    ).toEqual([]);
  });
});
