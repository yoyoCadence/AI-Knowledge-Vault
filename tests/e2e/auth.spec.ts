import { expect, test } from "@playwright/test";
import { E2E_ADMIN } from "./e2e-env";

test.describe("admin authentication", () => {
  test("anonymous visitors are redirected to the login page", async ({ page }) => {
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/login\?next=%2Fsettings/);
    await expect(page.getByRole("heading", { name: "登入" })).toBeVisible();
  });

  test("wrong password shows a clear error and no session", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("電子郵件").fill(E2E_ADMIN.email);
    await page.getByLabel("密碼").fill("not-the-right-password");
    await page.getByRole("button", { name: "登入" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "電子郵件或密碼錯誤。" })).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test("admin can log in, see sessions, and log out", async ({ page }) => {
    await page.goto("/login?next=/settings");
    await page.getByLabel("電子郵件").fill(E2E_ADMIN.email);
    await page.getByLabel("密碼").fill(E2E_ADMIN.password);
    await page.getByRole("button", { name: "登入" }).click();

    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole("heading", { name: "登入裝置與 Session" })).toBeVisible();
    await expect(page.getByText("目前裝置")).toBeVisible();

    await page.getByRole("link", { name: "知識庫" }).click();
    await expect(page.getByRole("heading", { name: "知識庫", level: 1 })).toBeVisible();

    await page.getByRole("button", { name: "登出" }).first().click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
  });

  test("open redirects are refused after login", async ({ page }) => {
    await page.goto("/login?next=//evil.example/");
    await page.getByLabel("電子郵件").fill(E2E_ADMIN.email);
    await page.getByLabel("密碼").fill(E2E_ADMIN.password);
    await page.getByRole("button", { name: "登入" }).click();
    await expect(page).toHaveURL("/");
  });
});
