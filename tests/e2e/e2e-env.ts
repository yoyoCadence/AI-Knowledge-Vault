import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");

export const E2E_PORT = 3100;
export const E2E_WORKER_HEALTH_PORT = 3191;
export const E2E_ADMIN = {
  email: "e2e-admin@example.test",
  name: "E2E Admin",
  password: "e2e-correct-horse-battery",
};

/** Environment for the E2E web server (and worker). Test-only secrets; separate database. */
export const e2eEnv: Record<string, string> = {
  APP_ENV: "test",
  LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
  NEXT_TELEMETRY_DISABLED: "1",
  APP_ORIGIN: `http://localhost:${E2E_PORT}`,
  PREVIEW_ORIGIN: `http://127.0.0.1:${E2E_PORT}`,
  DATABASE_URL: process.env.DATABASE_URL_E2E ?? "postgres://vault:vault@127.0.0.1:5432/vault_e2e",
  BETTER_AUTH_SECRET: "e2e-only-better-auth-secret-0123456789abcdef",
  PREVIEW_TOKEN_SECRET: "e2e-only-preview-token-secret-0123456789abcdef",
  LOCAL_STORAGE_SIGNING_SECRET: "e2e-only-local-storage-secret-0123456789abcdef",
  STORAGE_DRIVER: "local",
  LOCAL_STORAGE_DIR: path.join(root, ".data", "e2e-storage"),
  WORKER_POLL_INTERVAL_MS: "200",
};
