import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { claudeDesignZipEntries, htmlDocument } from "../fixtures/builders";
import { buildZip } from "../fixtures/zip";
import { e2eEnv } from "./e2e-env";
import { login } from "./helpers";

test.describe("import → library → artifact (Scenario A)", () => {
  test("batch upload shows progress and a per-file report; works appear in the library", async ({
    page,
  }) => {
    // In-memory payloads: Chromium in some containers drops file *paths* with non-ASCII names,
    // and we specifically want a Traditional Chinese filename in this scenario.
    // support.js is made to mutate the page: the preview must show the page without running it.
    const zipBytes = buildZip(
      (await claudeDesignZipEntries("端對端 Claude Design 報告")).map((entry) =>
        entry.name === "support.js"
          ? {
              ...entry,
              data: 'document.documentElement.dataset.scriptRan = "yes"; document.title = "pwned";',
            }
          : entry,
      ),
    );
    const files = [
      {
        name: "E2E 研究筆記.html",
        mimeType: "text/html",
        buffer: Buffer.from(htmlDocument({ title: "端對端測試筆記" })),
      },
      { name: "E2E_Claude_Design_Export.zip", mimeType: "application/zip", buffer: zipBytes },
      {
        name: "broken-file.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from("this is not a pdf"),
      },
    ];

    await login(page);
    await page.goto("/import");
    await page.getByTestId("import-file-input").setInputFiles(files);
    await expect(page.getByTestId("import-row")).toHaveCount(3);
    await page.getByRole("button", { name: "開始上傳" }).click();

    // Report converges: 2 succeeded, 1 failed with a precise reason.
    await expect(page.getByTestId("import-summary")).toHaveText(
      /2 完成 · 0 重複 · 1 失敗 · 0 處理中/,
      { timeout: 30_000 },
    );
    await expect(page.getByText("UNSUPPORTED_FILE_TYPE")).toBeVisible();

    // Library shows both works.
    await page.getByRole("link", { name: "知識庫" }).first().click();
    await expect(page.getByRole("heading", { name: "端對端 Claude Design 報告" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "端對端測試筆記" })).toBeVisible();

    // Search (Traditional Chinese, in the body): indexing runs right after import, so retry.
    await expect(async () => {
      await page.goto(`/?q=${encodeURIComponent("鋪面蓄熱")}`);
      await expect(page.getByTestId("search-results")).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
    const hit = page.getByTestId("search-results").getByRole("link").first();
    await expect(hit).toContainText("端對端 Claude Design 報告");
    await expect(hit.locator("mark")).toHaveText(["鋪面蓄熱"]);
    await page.goto("/");

    // Artifact detail: metadata, outline, and a byte-identical original download.
    await page.getByRole("heading", { name: "端對端 Claude Design 報告" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "端對端 Claude Design 報告" }),
    ).toBeVisible();
    await expect(page.getByText("Claude Design").first()).toBeVisible();
    await expect(page.getByText("30 秒答案")).toBeVisible();

    // Sandboxed preview on the preview origin (SECURITY.md §5): rendered, but no script ran.
    const frameElement = page.getByTestId("preview-frame");
    await expect(frameElement).toHaveAttribute("sandbox", "");
    await expect(frameElement).toHaveAttribute("referrerpolicy", "no-referrer");
    const frameUrl = (await frameElement.getAttribute("src"))!;
    expect(frameUrl.startsWith(`${e2eEnv.PREVIEW_ORIGIN}/p/`)).toBe(true);
    const frame = page.frameLocator('[data-testid="preview-frame"]');
    await expect(frame.getByRole("heading", { name: "端對端 Claude Design 報告" })).toBeVisible();
    await expect(frame.locator("html[data-script-ran]")).toHaveCount(0);
    const script = await page.request.get(new URL("support.js", frameUrl).href);
    expect(script.headers()["content-type"]).toBe("text/plain");
    expect(script.headers()["content-security-policy"]).toContain("script-src 'none'");
    expect(script.headers()["x-frame-options"]).toBeUndefined();
    // The app origin never serves /p/*, and the preview origin serves nothing else.
    expect((await page.request.get(frameUrl.replace(e2eEnv.PREVIEW_ORIGIN!, ""))).status()).toBe(
      404,
    );
    expect((await page.request.get(`${e2eEnv.PREVIEW_ORIGIN}/api/health`)).status()).toBe(404);

    // Reading mode: the same document rendered from its extraction, with a working outline.
    await page.getByRole("link", { name: "閱讀", exact: true }).click();
    await expect(page).toHaveURL(/[?&]view=read/);
    const reader = page.getByTestId("reader");
    await expect(reader.getByRole("heading", { name: "30 秒答案" })).toBeVisible();
    await expect(reader.locator("script, iframe, img")).toHaveCount(0);
    await page.getByRole("link", { name: "30 秒答案" }).click();
    await expect(page).toHaveURL(/#30-%E7%A7%92%E7%AD%94%E6%A1%88$/);
    await expect(page.locator("[id='30-秒答案']")).toBeInViewport();

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("link", { name: "下載原始檔", exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("E2E_Claude_Design_Export.zip");
    const downloaded = await readFile((await download.path())!);
    expect(createHash("sha256").update(downloaded).digest("hex")).toBe(
      createHash("sha256").update(zipBytes).digest("hex"),
    );

    // Portable export of the library (same session: sign-in is rate limited).
    await page.goto("/import");
    await page.getByTestId("export-create").click();
    const exportRow = page.getByTestId("export-row").first();
    await expect(exportRow.getByTestId("export-download")).toBeVisible({ timeout: 30_000 });
    const checksum = (await exportRow.getByText(/^SHA-256 /).textContent())!
      .replace("SHA-256", "")
      .trim();
    const exportDownload = page.waitForEvent("download");
    await exportRow.getByTestId("export-download").click();
    const archive = await exportDownload;
    expect(archive.suggestedFilename()).toMatch(/^knowledge-vault-export-.+\.zip$/);
    const archiveBytes = await readFile((await archive.path())!);
    expect(createHash("sha256").update(archiveBytes).digest("hex")).toBe(checksum);

    // Integrity check re-hashes every stored original.
    await page.getByTestId("integrity-run").click();
    await expect(page.getByTestId("integrity-result").getByText("全部正常")).toBeVisible({
      timeout: 30_000,
    });

    // Restore the archive we just downloaded: verified, and everything already exists.
    // The first /start response is lost after the server accepted it; retrying must start the
    // same run, never create (and upload) a second one.
    const creates: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/restores")
        creates.push(request.url());
    });
    let dropped = false;
    await page.route("**/api/restores/*/start", async (route) => {
      if (dropped) return route.continue();
      dropped = true;
      await route.fetch(); // the server starts the run...
      await route.abort("connectionreset"); // ...but the browser never hears back
    });
    await page.getByTestId("restore-file").setInputFiles({
      name: archive.suggestedFilename(),
      mimeType: "application/zip",
      buffer: archiveBytes,
    });
    await page.getByTestId("restore-start").click();
    await expect(page.getByTestId("restore-start")).toBeEnabled();
    expect(dropped).toBe(true);
    await page.getByTestId("restore-start").click();
    const result = page.getByTestId("restore-result");
    await expect(result.getByText("完成", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(result.getByText(/作品：還原 0 · 略過 2 · 副本 0 · 失敗 0/)).toBeVisible();
    expect(creates).toHaveLength(1);
  });

  test("anonymous visitors cannot reach import or artifact APIs", async ({ request }) => {
    expect((await request.get("/api/artifacts")).status()).toBe(401);
    expect((await request.get("/api/imports")).status()).toBe(401);
  });
});
