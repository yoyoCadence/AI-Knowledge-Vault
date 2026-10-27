import type { Page } from "@playwright/test";
import { E2E_ADMIN } from "./e2e-env";

/** A browser state with no session, for tests of what anonymous visitors get. */
export const SIGNED_OUT = { cookies: [], origins: [] };

/** Signs in through the login form. */
export async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("電子郵件").fill(E2E_ADMIN.email);
  await page.getByLabel("密碼").fill(E2E_ADMIN.password);
  await page.getByRole("button", { name: "登入" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

/**
 * Makes sure the page is signed in: specs start from the session `auth.setup.ts` saved, and sign
 * in again only if it is gone (a spec that signs out ends only its own session).
 */
export async function login(page: Page) {
  await page.goto("/");
  if (new URL(page.url()).pathname.startsWith("/login")) await signIn(page);
}
