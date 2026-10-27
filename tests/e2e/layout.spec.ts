import { expect, test } from "@playwright/test";
import { htmlDocument } from "../fixtures/builders";
import { attempt, login } from "./helpers";

test.describe("library layout (grid or list)", () => {
  test("the list shows a row per work, and the choice stays", async ({ page }) => {
    const run = attempt();
    const title = `版面測試 ${run}`;
    await login(page);
    await page.goto("/import");
    await page.getByTestId("import-file-input").setInputFiles([
      {
        name: `layout-${run}.html`,
        mimeType: "text/html",
        buffer: Buffer.from(htmlDocument({ title, body: `<p>${title} 的內容。</p>` })),
      },
    ]);
    await page.getByRole("button", { name: "開始上傳" }).click();
    await expect(page.getByTestId("import-summary")).toHaveText(/1 完成/, { timeout: 30_000 });

    await page.goto("/");
    const layout = page.getByRole("group", { name: "版面" });
    const library = page.getByRole("region", { name: "知識庫", exact: true });
    await expect(layout.getByRole("button", { name: "格狀" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(library.getByTestId("artifact-row")).toHaveCount(0);
    const cards = await library.getByRole("heading", { level: 3 }).count();

    await layout.getByRole("button", { name: "清單" }).click();
    await expect(layout.getByRole("button", { name: "清單" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // The same works, one row each, without thumbnails.
    await expect(library.getByTestId("artifact-row")).toHaveCount(cards);
    await expect(library.locator("img")).toHaveCount(0);
    const row = library.getByTestId("artifact-row").filter({ hasText: title });
    await expect(row).toHaveAttribute("href", /^\/artifacts\//);

    // It stays: after a reload, and on another view of the library.
    await page.reload();
    await expect(library.getByTestId("artifact-row").first()).toBeVisible();
    await page.goto("/?sort=oldest");
    await expect(library.getByTestId("artifact-row").first()).toBeVisible();
    await row.click();
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();

    await page.goto("/");
    await layout.getByRole("button", { name: "格狀" }).click();
    await expect(library.getByTestId("artifact-row")).toHaveCount(0);
    await expect(library.getByRole("heading", { level: 3 })).toHaveCount(cards);
  });
});
