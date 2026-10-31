import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { testEnv } from "./tests/test-env.ts";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@tests": path.join(root, "tests"),
      "@": path.join(root, "src"),
    },
  },
  test: {
    env: { ...testEnv },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          globalSetup: ["tests/integration/global-setup.ts"],
          // One shared database: run files sequentially for determinism.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
