import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * `pnpm storage:verify`: the storage adapter suite against a real bucket, such as R2
 * (DEPLOYMENT.md §5.2, step 5). Only that file runs, and none of the integration project's
 * setup: it needs no database, and it resets none. `S3_TEST_VERIFY` makes a missing variable
 * an error, so a skipped run is never mistaken for a verified one.
 */
const root = path.dirname(new URL(import.meta.url).pathname);

export default defineConfig({
  resolve: {
    alias: {
      "@tests": path.join(root, "tests"),
      "@": path.join(root, "src"),
    },
  },
  test: {
    include: ["tests/integration/storage/s3-adapter.test.ts"],
    environment: "node",
    env: { S3_TEST_VERIFY: "1" },
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
