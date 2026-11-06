import { expect, type Route, test } from "@playwright/test";
import { attempt, login } from "./helpers";

test.describe("a request that fails says why", () => {
  test("offline, and after the session ended, in words of our own", async ({ page, context }) => {
    await login(page);
    await page.goto("/projects");
    const form = page.getByTestId("project-create");
    await form.getByPlaceholder("新專案名稱").fill(`離線時建立 ${attempt()}`);

    // The connection drops: not the browser's "Failed to fetch".
    await context.setOffline(true);
    await form.getByRole("button", { name: "建立專案" }).click();
    await expect(form.getByRole("alert")).toHaveText(/無法連線到伺服器/);

    // Back online, but the session is gone: sign in again, not "try again".
    await context.setOffline(false);
    await context.clearCookies();
    await form.getByRole("button", { name: "建立專案" }).click();
    await expect(form.getByRole("alert")).toHaveText(/登入已過期/);
  });

  test("a sign-out that did not happen says so and stays", async ({ page }) => {
    await login(page);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    // The server fails, then the connection drops: the session is still valid both times, so
    // the page must not go to /login (which sent the user back here, signed in, unannounced).
    for (const fail of [
      (route: Route) => route.fulfill({ status: 500, body: "{}" }),
      (route: Route) => route.abort("internetdisconnected"),
    ]) {
      await page.route("**/api/auth/sign-out", fail);
      await page.getByRole("button", { name: "登出" }).first().click();
      await expect(page.getByTestId("logout-error").first()).toHaveText(/登出沒有完成/);
      expect(new URL(page.url()).pathname).toBe("/");
      await page.unroute("**/api/auth/sign-out");
    }
    expect(pageErrors).toEqual([]);
  });
});
