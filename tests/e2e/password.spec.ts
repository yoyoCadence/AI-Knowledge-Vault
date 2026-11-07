import { expect, type Page, test } from "@playwright/test";
import { e2eEnv } from "./e2e-env";
import { attempt, SIGNED_OUT } from "./helpers";

// An owner of their own, so the change cannot sign out the session the other specs share, from
// an address of its own (sign-in is limited per address).
const HEADERS = { "x-forwarded-for": "198.51.100.42" };
test.use({ storageState: SIGNED_OUT, extraHTTPHeaders: HEADERS });

const OLD = "the-first-password-2026";
const NEW = "the-second-password-2026";

async function signInAs(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("電子郵件").fill(email);
  await page.getByLabel("密碼").fill(password);
  await page.getByRole("button", { name: "登入" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

test.describe("changing the password (settings)", () => {
  test("says what is wrong, and a change signs out the other devices only", async ({
    page,
    browser,
  }) => {
    const { createDatabase } = await import("../../src/infrastructure/database/client");
    const { createAdmin } = await import("../../src/modules/auth/admin");
    const db = createDatabase(e2eEnv.DATABASE_URL!, { max: 1 });
    const email = `password-${attempt()}-${Date.now()}@example.test`;
    try {
      await createAdmin(db, { email, name: "Password Owner", password: OLD });
    } finally {
      await db.$client.end();
    }

    await signInAs(page, email, OLD);
    const elsewhere = await browser.newContext({
      baseURL: e2eEnv.APP_ORIGIN,
      extraHTTPHeaders: HEADERS,
    });
    const otherDevice = await elsewhere.newPage();
    await signInAs(otherDevice, email, OLD);

    await page.goto("/settings");
    const panel = page.getByTestId("password-panel");
    const fill = async (current: string, next: string, confirm: string) => {
      await panel.getByLabel("目前的密碼").fill(current);
      await panel.getByLabel(/^新密碼/).fill(next);
      await panel.getByLabel("再輸入一次新密碼").fill(confirm);
      await panel.getByRole("button", { name: "變更密碼" }).click();
    };

    await fill(OLD, NEW, `${NEW}-typo`);
    await expect(panel.getByRole("alert")).toHaveText("兩次輸入的新密碼不一致。");
    await fill("not-the-current-password", NEW, NEW);
    await expect(panel.getByRole("alert")).toHaveText("目前的密碼不正確。");

    await fill(OLD, NEW, NEW);
    await expect(panel.getByTestId("password-done")).toHaveText("已變更密碼，其他裝置都已登出。");
    await expect(panel.getByLabel("目前的密碼")).toHaveValue("");

    // This device stays signed in; the other one is out.
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/settings$/);
    await otherDevice.goto("/");
    await expect(otherDevice).toHaveURL(/\/login/);
    await elsewhere.close();
  });
});
