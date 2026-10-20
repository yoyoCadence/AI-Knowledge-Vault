import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/**
 * Test environment: deterministic, test-only secrets — never real credentials.
 * Shared by vitest.config.ts (workers) and integration global setup (main process).
 */
export const testEnv = {
  NODE_ENV: "test",
  APP_ENV: "test",
  LOG_LEVEL: process.env.LOG_LEVEL ?? "silent",
  APP_ORIGIN: "http://localhost:3100",
  PREVIEW_ORIGIN: "http://127.0.0.1:3100",
  DATABASE_URL: process.env.DATABASE_URL_TEST ?? "postgres://vault:vault@127.0.0.1:5432/vault_test",
  BETTER_AUTH_SECRET: "test-only-better-auth-secret-0123456789abcdef",
  PREVIEW_TOKEN_SECRET: "test-only-preview-token-secret-0123456789abcdef",
  LOCAL_STORAGE_SIGNING_SECRET: "test-only-local-storage-secret-0123456789abcdef",
  STORAGE_DRIVER: "local",
  LOCAL_STORAGE_DIR: path.join(root, ".data", "test-storage"),
} as const;
