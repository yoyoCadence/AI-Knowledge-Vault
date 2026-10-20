import { defineConfig } from "drizzle-kit";

// Used by `drizzle-kit generate` only. Migrations are applied by scripts/db-migrate.ts.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/infrastructure/database/schema/index.ts",
  out: "./drizzle",
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://unused-for-generate",
  },
});
