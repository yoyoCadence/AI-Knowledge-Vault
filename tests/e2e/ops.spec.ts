import { expect, test } from "@playwright/test";
import { e2eEnv } from "./e2e-env";
import { login, SIGNED_OUT } from "./helpers";

test.describe("usage and status (FR-OPS-2/3)", () => {
  test("the owner sees real numbers: storage, jobs, failed imports, backup state", async ({
    page,
  }) => {
    await login(page);
    // Its own data, so the spec stands alone: a file that fails, a work, and an export.
    await page.goto("/import");
    await page.getByTestId("import-file-input").setInputFiles([
      { name: "ops-broken.pdf", mimeType: "application/pdf", buffer: Buffer.from("not a pdf") },
      {
        name: "ops-note.md",
        mimeType: "text/markdown",
        buffer: Buffer.from("# 用量測試\n\n內容。\n"),
      },
    ]);
    await page.getByRole("button", { name: "開始上傳" }).click();
    await expect(page.getByTestId("import-summary")).toHaveText(/1 失敗 · 0 處理中/, {
      timeout: 30_000,
    });
    const exported = await page.request.post("/api/exports", {
      headers: { origin: e2eEnv.APP_ORIGIN! },
      data: {},
    });
    expect(exported.status()).toBe(202);

    await page.goto("/settings");
    await page.getByRole("link", { name: "查看使用量與狀態" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("使用量與狀態");
    await expect(page.getByTestId("usage-storage")).toContainText(/原始檔\s*[1-9]\d* 個 · /);
    await expect(page.getByTestId("usage-library")).toContainText(/[1-9]\d* 份作品/);
    await expect(page.getByTestId("usage-database")).toHaveText(/\d/);
    await expect(page.getByTestId("usage-import-failures")).toContainText("ops-broken.pdf");
    await expect(page.getByTestId("usage-job-failures")).toContainText("UNSUPPORTED_FILE_TYPE");
    await expect(page.getByTestId("usage-jobs")).toContainText(/失敗\s*[1-9]/);
    // The export runs in the background worker.
    await expect(async () => {
      await page.reload();
      await expect(page.getByTestId("usage-backup")).toContainText("最後一次成功匯出", {
        timeout: 1_000,
      });
    }).toPass({ timeout: 30_000 });
  });

  test.describe("signed out", () => {
    test.use({ storageState: SIGNED_OUT });

    test("is not offered to anonymous visitors", async ({ request, page }) => {
      expect((await request.get("/api/ops/usage")).status()).toBe(401);
      await page.goto("/settings/usage");
      await expect(page).toHaveURL(/\/login/);
    });
  });
});
