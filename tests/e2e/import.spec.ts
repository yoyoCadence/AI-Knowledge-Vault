import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { claudeDesignZipEntries, htmlDocument } from "../fixtures/builders";
import { buildZip } from "../fixtures/zip";
import { login } from "./helpers";

test.describe("import → library → artifact (Scenario A)", () => {
  test("batch upload shows progress and a per-file report; works appear in the library", async ({
    page,
  }) => {
    // In-memory payloads: Chromium in some containers drops file *paths* with non-ASCII names,
    // and we specifically want a Traditional Chinese filename in this scenario.
    const zipBytes = buildZip(await claudeDesignZipEntries("端對端 Claude Design 報告"));
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

    // Artifact detail: metadata, outline, and a byte-identical original download.
    await page.getByRole("heading", { name: "端對端 Claude Design 報告" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "端對端 Claude Design 報告" }),
    ).toBeVisible();
    await expect(page.getByText("Claude Design").first()).toBeVisible();
    await expect(page.getByText("30 秒答案")).toBeVisible();

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
    await page.getByTestId("restore-file").setInputFiles({
      name: archive.suggestedFilename(),
      mimeType: "application/zip",
      buffer: archiveBytes,
    });
    await page.getByTestId("restore-start").click();
    const result = page.getByTestId("restore-result");
    await expect(result.getByText("完成", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(result.getByText(/作品：還原 0 · 略過 2 · 副本 0 · 失敗 0/)).toBeVisible();
  });

  test("anonymous visitors cannot reach import or artifact APIs", async ({ request }) => {
    expect((await request.get("/api/artifacts")).status()).toBe(401);
    expect((await request.get("/api/imports")).status()).toBe(401);
  });
});
