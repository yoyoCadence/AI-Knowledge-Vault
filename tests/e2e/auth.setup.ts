import { mkdir } from "node:fs/promises";
import path from "node:path";
import { test as setup } from "@playwright/test";
import { E2E_ADMIN_STATE } from "./e2e-env";
import { signIn } from "./helpers";

/** Signs the admin in once for the whole run (sign-in is rate limited per address). */
setup("sign in the admin", async ({ page }) => {
  await signIn(page);
  await mkdir(path.dirname(E2E_ADMIN_STATE), { recursive: true });
  await page.context().storageState({ path: E2E_ADMIN_STATE });
});
