import type { Page } from "@playwright/test";
import { E2E_ADMIN } from "./e2e-env";

export async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("電子郵件").fill(E2E_ADMIN.email);
  await page.getByLabel("密碼").fill(E2E_ADMIN.password);
  await page.getByRole("button", { name: "登入" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}
