/**
 * Bundles Node entry points for production images (DEPLOYMENT.md §3):
 *   dist/worker.mjs      background job worker
 *   dist/db-migrate.mjs  migration runner (no tsx needed in production)
 *   dist/admin-create.mjs, dist/backup-export.mjs, dist/backup-restore.mjs  operator CLIs
 * Dependencies stay external (resolved from node_modules); only our source is bundled.
 */
import path from "node:path";
import { build } from "esbuild";

const root = process.cwd();

const entries: Record<string, string> = {
  worker: "src/worker/main.ts",
  "db-migrate": "scripts/db-migrate.ts",
  "admin-create": "scripts/admin-create.ts",
  "backup-export": "scripts/backup-export.ts",
  "backup-restore": "scripts/backup-restore.ts",
};

await build({
  entryPoints: Object.fromEntries(
    Object.entries(entries).map(([name, file]) => [name, path.join(root, file)]),
  ),
  outdir: path.join(root, "dist"),
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap: true,
  alias: { "@": path.join(root, "src") },
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: "info",
});
