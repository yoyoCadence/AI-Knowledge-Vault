import { expect, test } from "@playwright/test";
import { attempt, login } from "./helpers";

test.describe("library summary (FR-LIB-1)", () => {
  test("the library says how many works it holds and how they are kept", async ({ page }) => {
    const run = attempt();
    const title = `概況測試 ${run}`;
    await login(page);
    await page.goto("/import");
    await page.getByTestId("import-file-input").setInputFiles([
      {
        name: `summary-${run}.md`,
        mimeType: "text/markdown",
        buffer: Buffer.from(`# ${title}\n\n作品庫概況的測試內容。\n`),
      },
    ]);
    await page.getByRole("button", { name: "開始上傳" }).click();
    await expect(page.getByTestId("import-summary")).toHaveText(/1 完成/, { timeout: 30_000 });

    await page.goto("/");
    const summary = page.getByTestId("library-summary");
    await expect(summary).toBeVisible();
    // Every work of the E2E library fits on the first page, so the cards are all of them.
    await expect(page.getByRole("link", { name: "載入更多" })).toHaveCount(0);
    const cards = page
      .getByRole("region", { name: "知識庫", exact: true })
      .getByRole("heading", { level: 3 });
    await expect(cards.first()).toBeVisible();
    await expect(summary).toContainText(`${await cards.count()} 份作品`);
    await expect(page.getByTestId("library-preservation")).toContainText("保存狀態");
    // The owner can open the details.
    await expect(summary.getByRole("link", { name: "查看用量與狀態" })).toHaveAttribute(
      "href",
      "/settings/usage",
    );

    // A kind narrows the library to it; a narrowed library shows no summary.
    await summary.getByRole("link", { name: /^Markdown \d+$/ }).click();
    await expect(page).toHaveURL(/\/\?kind=markdown$/);
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(page.getByTestId("library-summary")).toHaveCount(0);
  });
});
