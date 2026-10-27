import { expect, test } from "@playwright/test";
import { htmlDocument } from "../fixtures/builders";
import { attempt, login } from "./helpers";

test.describe("version split (P1B-VERSION-SPLIT)", () => {
  test("a version the import matched wrongly becomes a work of its own", async ({ page }) => {
    const run = attempt();
    const stem = `estuary-${run}`;
    const title = `河口觀測 ${run}`;
    const other = `誤配的另一份研究 ${run}`;
    await login(page);
    // One after the other: the second file's name makes the import take it for a new version.
    for (const [name, documentTitle] of [
      [`${stem}.html`, title],
      [`${stem} (1).html`, other],
    ] as const) {
      await page.goto("/import");
      await page.getByTestId("import-file-input").setInputFiles([
        {
          name,
          mimeType: "text/html",
          buffer: Buffer.from(
            htmlDocument({ title: documentTitle, body: `<p>${documentTitle} 的內容。</p>` }),
          ),
        },
      ]);
      await page.getByRole("button", { name: "開始上傳" }).click();
      await expect(page.getByTestId("import-summary")).toHaveText(/1 完成/, { timeout: 30_000 });
    }

    await page.goto("/");
    await page.getByRole("heading", { name: title }).click();
    const rows = page.getByTestId("version-row");
    await expect(rows).toHaveCount(2);
    const wrong = rows.filter({ hasText: `${stem} (1).html` });

    // The scissors explain, and confirming is a button of its own: a double-click on the
    // scissors only opens the explanation. On a narrow screen it wraps under the row.
    await page.setViewportSize({ width: 360, height: 800 });
    await wrong.getByRole("button", { name: "拆成獨立作品 V2" }).dblclick();
    await expect(wrong).toContainText("分享連結都留在這件作品");
    // The split one is current: the explanation says the work will show another version.
    await expect(wrong).toContainText("這是目前版本");
    await expect(rows).toHaveCount(2);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0);
    await wrong.getByRole("button", { name: "取消" }).click();
    await expect(wrong).not.toContainText("分享連結都留在這件作品");

    await wrong.getByRole("button", { name: "拆成獨立作品 V2" }).click();
    await wrong.getByRole("button", { name: "確認拆分 V2" }).click();
    // The new work opens, with the moved version as its only one.
    await expect(page.getByRole("heading", { level: 1, name: other })).toBeVisible();
    await expect(page.getByTestId("version-row")).toHaveCount(1);
    await expect(page.getByTestId("version-row")).toContainText("V1");

    // The old work keeps its first version, with nothing left to split.
    await page.goto("/");
    await page.getByRole("heading", { name: title }).click();
    await expect(page.getByTestId("version-row")).toHaveCount(1);
    await expect(page.getByRole("button", { name: /拆成獨立作品/ })).toHaveCount(0);
  });
});
