import { expect, test } from "@playwright/test";
import { htmlDocument } from "../fixtures/builders";
import { login } from "./helpers";

test.describe("source metadata (FR-LIB-6)", () => {
  test("an editor records where a work came from, and search finds it", async ({ page }) => {
    await login(page);
    await page.goto("/import");
    await page.getByTestId("import-file-input").setInputFiles([
      {
        name: "source-e2e.html",
        mimeType: "text/html",
        // Distinct bytes per attempt: a retry's upload must not be a duplicate.
        buffer: Buffer.from(
          htmlDocument({
            title: "來源資訊端對端",
            body: `<p>來源內容 attempt ${test.info().retry}</p>`,
          }),
        ),
      },
    ]);
    await page.getByRole("button", { name: "開始上傳" }).click();
    await expect(page.getByTestId("import-summary")).toHaveText(/1 完成/, { timeout: 30_000 });
    await page.goto("/");
    await page.getByRole("heading", { name: "來源資訊端對端" }).click();

    await page.getByRole("button", { name: "編輯來源資訊" }).click();
    const editor = page.getByTestId("source-editor");
    await editor.getByRole("combobox", { name: "來源平台" }).selectOption("gemini");
    await editor.getByRole("textbox", { name: "來源模型" }).fill("潮汐模型 Z9");
    await editor.getByLabel("研究日期").fill("2025-03-14");
    await editor.getByRole("textbox", { name: "作者" }).fill("端對端研究員");
    await editor.getByRole("textbox", { name: "來源網址" }).fill("https://example.org/research");
    await editor.getByRole("button", { name: "儲存" }).click();

    const source = page.getByTestId("source");
    await expect(source).toContainText("Gemini");
    await expect(source).toContainText("潮汐模型 Z9");
    await expect(source).toContainText("2025-03-14");
    await expect(source).toContainText("端對端研究員");
    const link = source.getByRole("link", { name: "https://example.org/research" });
    await expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");

    // Search results are links (with snippets), not cards; the model is in the filter too.
    await page.goto(`/?q=${encodeURIComponent("潮汐模型")}`);
    await expect(page.getByRole("link", { name: /來源資訊端對端/ })).toBeVisible();
    await expect(page.getByRole("option", { name: "潮汐模型 Z9" })).toBeAttached();
  });

  test("an imported value the browser would refuse does not block other edits", async ({
    page,
  }) => {
    await login(page);
    await page.goto("/import");
    await page.getByTestId("import-file-input").setInputFiles([
      {
        name: "front-matter.md",
        mimeType: "text/markdown",
        buffer: Buffer.from(
          `---\nsource_url: http://%zz/report\nauthor: 原作者\n---\n# 前置資料測試\n\n內容 attempt ${test.info().retry}。\n`,
        ),
      },
    ]);
    await page.getByRole("button", { name: "開始上傳" }).click();
    await expect(page.getByTestId("import-summary")).toHaveText(/1 完成/, { timeout: 30_000 });
    await page.goto("/");
    await page.getByRole("heading", { name: "前置資料測試" }).click();
    const source = page.getByTestId("source");
    await expect(source).toContainText("原作者");

    await page.getByRole("button", { name: "編輯來源資訊" }).click();
    const editor = page.getByTestId("source-editor");
    await editor.getByRole("textbox", { name: "來源模型" }).fill("只改模型");
    await editor.getByRole("button", { name: "儲存" }).click();
    await expect(source).toContainText("只改模型");
    await expect(source).toContainText("http://%zz/report");
  });
});
