import { expect, test } from "@playwright/test";
import { login, SIGNED_OUT } from "./helpers";

test.describe("usage and status (FR-OPS-2/3)", () => {
  test("the owner sees real numbers: storage, jobs, failed imports, backup state", async ({
    page,
  }) => {
    await login(page);
    await page.goto("/settings");
    await page.getByRole("link", { name: "查看使用量與狀態" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("使用量與狀態");

    // Earlier specs imported works into this database, including one broken file.
    const storage = page.getByTestId("usage-storage");
    await expect(storage).toContainText(/原始檔\s*[1-9]\d* 個 · /);
    await expect(page.getByTestId("usage-library")).toContainText(/[1-9]\d* 份作品/);
    await expect(page.getByTestId("usage-database")).toHaveText(/\d/);
    await expect(page.getByTestId("usage-import-failures")).toContainText("broken-file.pdf");
    await expect(page.getByTestId("usage-jobs")).toContainText("失敗");
    await expect(page.getByTestId("usage-backup")).toContainText("匯入與備份");
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
