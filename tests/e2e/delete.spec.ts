import { expect, test } from "@playwright/test";
import { htmlDocument } from "../fixtures/builders";
import { attempt, login } from "./helpers";

test.describe("delete and undo (ADR-017)", () => {
  test("a deleted work leaves the library and search, and comes back on undo", async ({ page }) => {
    const run = attempt();
    const title = `刪除復原測試 ${run}`;
    const word = `Tamarisk${run}`;
    await login(page);
    await page.goto("/import");
    await page.getByTestId("import-file-input").setInputFiles([
      {
        name: `delete-${run}.html`,
        mimeType: "text/html",
        buffer: Buffer.from(htmlDocument({ title, body: `<p>${word} 的觀察紀錄。</p>` })),
      },
    ]);
    await page.getByRole("button", { name: "開始上傳" }).click();
    await expect(page.getByTestId("import-summary")).toHaveText(/1 完成/, { timeout: 30_000 });

    await page.goto("/");
    await page.getByRole("heading", { name: title }).click();
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    const artifactUrl = page.url();

    // Deleting says what it does and needs its own confirm: a double click only explains.
    const zone = page.getByTestId("artifact-delete");
    await zone.getByRole("button", { name: "刪除這件作品" }).dblclick();
    await expect(zone).toContainText("原始檔、版本、筆記與標籤都會保留");
    await zone.getByRole("button", { name: "取消" }).click();
    await expect(zone).not.toContainText("原始檔、版本、筆記與標籤都會保留");
    await zone.getByRole("button", { name: "刪除這件作品" }).click();
    await zone.getByRole("button", { name: "確認刪除" }).click();

    // The library says so and offers to undo; the work is in neither the library nor search.
    const notice = page.getByTestId("deleted-notice");
    await expect(notice).toContainText(`已刪除「${title}」`);
    await expect(page.getByRole("heading", { name: title })).toHaveCount(0);
    await page.goto(`/?q=${encodeURIComponent(word)}`);
    await expect(page.getByTestId("search-none")).toBeVisible();
    const gone = await page.goto(artifactUrl);
    expect(gone?.status()).toBe(404);

    // The deleted list has it, and restores it from there.
    await page.goto("/settings");
    await page.getByRole("link", { name: "已刪除的作品" }).click();
    const row = page.getByTestId("deleted-item").filter({ hasText: title });
    await expect(row).toContainText("刪除於");
    await row.getByRole("button", { name: `復原「${title}」` }).click();
    await expect(row).toHaveCount(0);

    await page.goto(`/?q=${encodeURIComponent(word)}`);
    await expect(page.getByRole("link", { name: new RegExp(title) })).toBeVisible();

    // Undo right after deleting opens the work again.
    await page.goto(artifactUrl);
    await page.getByTestId("artifact-delete").getByRole("button", { name: "刪除這件作品" }).click();
    await page.getByTestId("artifact-delete").getByRole("button", { name: "確認刪除" }).click();
    await page.getByTestId("deleted-notice").getByRole("button", { name: "復原" }).click();
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    expect(page.url()).toBe(artifactUrl);
  });
});
