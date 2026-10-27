import { expect, test } from "@playwright/test";
import { htmlDocument } from "../fixtures/builders";
import { e2eEnv } from "./e2e-env";
import { login } from "./helpers";

test.describe("share links (Scenario: share a work, then take it back)", () => {
  test("create → open signed out → revoke → 404", async ({ page, browser }) => {
    await login(page);
    await page.goto("/import");
    await page.getByTestId("import-file-input").setInputFiles([
      {
        name: "share-e2e.html",
        mimeType: "text/html",
        buffer: Buffer.from(
          htmlDocument({
            title: "分享端對端報告",
            body: "<h2>結論</h2><p>透水鋪面降低地表溫度。聯絡 e2e@example.com</p>",
          }),
        ),
      },
    ]);
    await page.getByRole("button", { name: "開始上傳" }).click();
    await expect(page.getByTestId("import-summary")).toHaveText(/1 完成/, { timeout: 30_000 });
    await page.goto("/");
    await page.getByRole("heading", { name: "分享端對端報告" }).click();

    // The check runs first and shows what it found; the owner then picks the options.
    const panel = page.getByTestId("share-panel");
    await expect(panel.getByTestId("share-visibility")).toContainText("私人");
    await panel.getByRole("button", { name: "建立分享連結" }).click();
    await expect(panel.getByTestId("share-findings")).toContainText("Email 地址 1 個");
    await expect(panel).toContainText("改為「不公開列出」");
    await panel.getByRole("checkbox", { name: "允許下載原始檔" }).check();
    await panel.getByRole("button", { name: "確認建立" }).click();
    const url = await panel.getByTestId("share-url").inputValue();
    expect(url).toMatch(new RegExp(`^${e2eEnv.APP_ORIGIN}/s/[A-Za-z0-9_-]{43}$`));
    await expect(panel.getByTestId("share-row")).toHaveCount(1);
    await expect(panel.getByTestId("share-visibility")).toContainText("不公開列出");

    // A visitor with no session sees the work, and nothing else of the workspace.
    const visitor = await browser.newContext();
    const reader = await visitor.newPage();
    const response = await reader.goto(url);
    expect(response?.status()).toBe(200);
    expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
    expect(response?.headers()["x-robots-tag"]).toBe("noindex, nofollow");
    await expect(reader.getByRole("heading", { level: 1 })).toHaveText("分享端對端報告");
    await expect(reader.getByTestId("preview-frame")).toHaveAttribute(
      "src",
      new RegExp(`^${e2eEnv.PREVIEW_ORIGIN}/p/`),
    );
    await reader.getByRole("link", { name: "閱讀", exact: true }).click();
    await expect(reader.getByTestId("reader")).toContainText("透水鋪面降低地表溫度");
    await expect(reader.getByTestId("share-download")).toBeVisible();
    await expect(reader.getByTestId("notes")).toHaveCount(0);
    await expect(reader.getByRole("link", { name: "知識庫" })).toHaveCount(0);

    // Revoked: the same URL is a plain 404 at once.
    const row = panel.getByTestId("share-row");
    await row.getByRole("button", { name: "撤銷" }).click();
    await row.getByRole("button", { name: "再按一次確認撤銷" }).click();
    await expect(row).toContainText("已撤銷");
    const gone = await reader.goto(url);
    expect(gone?.status()).toBe(404);
    await visitor.close();

    // Private again: the artifact leaves "unlisted".
    await panel.getByRole("button", { name: "改回私人（撤銷所有連結）" }).click();
    await panel.getByRole("button", { name: "再按一次確認改回私人" }).click();
    await expect(panel.getByTestId("share-visibility")).toContainText("私人：");
  });
});
