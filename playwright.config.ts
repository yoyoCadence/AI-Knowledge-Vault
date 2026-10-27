import { defineConfig, devices } from "@playwright/test";
import { E2E_ADMIN_STATE, e2eEnv, E2E_PORT, E2E_WORKER_HEALTH_PORT } from "./tests/e2e/e2e-env";

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
    // Signs in once; the other projects start from that session (see E2E_ADMIN_STATE).
    { name: "setup", testMatch: "**/*.setup.ts" },
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], storageState: E2E_ADMIN_STATE },
      testIgnore: "**/*.mobile.spec.ts",
      dependencies: ["setup"],
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"], storageState: E2E_ADMIN_STATE },
      testMatch: "**/*.mobile.spec.ts",
      dependencies: ["setup"],
    },
  ],
  webServer: [
    {
      command: `pnpm exec next start -p ${E2E_PORT}`,
      url: `${e2eEnv.APP_ORIGIN}/api/health`,
      env: e2eEnv,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // Background worker (bundled by `pnpm build:node`); readiness via its localhost health port.
      command: "node dist/worker.mjs",
      url: `http://127.0.0.1:${E2E_WORKER_HEALTH_PORT}/healthz`,
      env: { ...e2eEnv, WORKER_HEALTH_PORT: String(E2E_WORKER_HEALTH_PORT) },
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
