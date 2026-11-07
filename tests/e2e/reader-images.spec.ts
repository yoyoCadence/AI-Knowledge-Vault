import { expect, test } from "@playwright/test";
import { pngImage } from "../fixtures/builders";
import { buildZip } from "../fixtures/zip";
import { attempt, login } from "./helpers";

test.describe("reading mode images", () => {
  test("shows the document's own images and loads nothing from elsewhere", async ({ page }) => {
    const run = attempt();
    const title = `圖片閱讀測試 ${run}`;
    const pixel =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const zip = buildZip([
      {
        name: "site/index.html",
        data: `<!doctype html><html lang="zh-Hant"><head><title>${title}</title></head><body>
<h1>${title}</h1><p>長條圖如下。</p><img src="img/chart.png" alt="長條圖">
<img src="data:image/png;base64,${pixel}" alt="內嵌圖">
<img src="https://tracker.example/pixel.png" alt="外部圖"></body></html>`,
      },
      { name: "site/img/chart.png", data: await pngImage(40, 20) },
    ]);
    // Reading mode is the page itself (the main frame). The preview, a sandboxed frame on the
    // preview origin, may try the remote image too: its CSP refuses it before it is sent.
    const fromReader: string[] = [];
    const reached: string[] = [];
    const remote = (url: string) => new URL(url).hostname === "tracker.example";
    page.on("request", (request) => {
      if (remote(request.url()) && request.frame() === page.mainFrame())
        fromReader.push(request.url());
    });
    page.on("requestfinished", (request) => {
      if (remote(request.url())) reached.push(request.url());
    });
    page.on("requestfailed", (request) => {
      if (remote(request.url()) && request.failure()?.errorText !== "csp")
        reached.push(request.url());
    });

    await login(page);
    await page.goto("/import");
    await page
      .getByTestId("import-file-input")
      .setInputFiles([{ name: `images-${run}.zip`, mimeType: "application/zip", buffer: zip }]);
    await page.getByRole("button", { name: "開始上傳" }).click();
    await expect(page.getByTestId("import-summary")).toHaveText(/1 完成/, { timeout: 30_000 });
    await page.goto("/");
    await page.getByRole("heading", { name: title }).click();
    // A site opens on its preview; reading mode is the other view.
    await page.waitForURL(/\/artifacts\/[^/?]+$/);
    await page.goto(`${new URL(page.url()).pathname}?view=read`);

    const reader = page.getByTestId("reader");
    // The bundle's file comes from the preview origin; the data: image is the document's own.
    for (const alt of ["長條圖", "內嵌圖"]) {
      const image = reader.getByRole("img", { name: alt });
      await expect(image).toBeVisible();
      await expect
        .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
        .toBeGreaterThan(0);
    }
    expect(await reader.getByRole("img", { name: "長條圖" }).getAttribute("src")).toMatch(
      /^http:\/\/127\.0\.0\.1:3100\/p\/[^/]+\/img\/chart\.png$/,
    );
    // A remote image stays its alt text, and is never requested.
    await expect(reader.getByRole("img", { name: "外部圖" })).toHaveCount(0);
    await expect(reader).toContainText("［圖片：外部圖］");
    expect(fromReader).toEqual([]);
    expect(reached).toEqual([]);
  });
});
