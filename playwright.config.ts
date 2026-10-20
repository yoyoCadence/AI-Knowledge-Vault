import { defineConfig, devices } from "@playwright/test";
import { e2eEnv, E2E_PORT } from "./tests/e2e/e2e-env";

/**
 * E2E against a production build (`pnpm build` first) on port 3100 with its own database.
 * Playwright is pinned to the Chromium build pre-installed in the dev container (ADR-013).
 */
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  globalSetup: "./tests/e2e/global-setup.ts",
  timeout: 30_000,
  use: {
    baseURL: e2eEnv.APP_ORIGIN,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    locale: "zh-TW",
    timezoneId: "Asia/Taipei",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: "**/*.mobile.spec.ts" },
  ],
  webServer: [
    {
      command: `pnpm exec next start -p ${E2E_PORT}`,
      url: `${e2eEnv.APP_ORIGIN}/api/health`,
      env: e2eEnv,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
