/**
 * Applies pending migrations: `pnpm db:migrate`.
 * Uses DATABASE_URL_DIRECT when set (Neon: non-pooled endpoint for DDL), else DATABASE_URL.
 */
import { createDatabase } from "@/infrastructure/database/client";
import { runMigrations } from "@/infrastructure/database/migrate";

async function main() {
  const url = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL (or DATABASE_URL_DIRECT) is required");
    process.exit(1);
  }
  const db = createDatabase(url, { max: 1 });
  try {
    await runMigrations(db);
    console.log("Migrations applied.");
  } finally {
    await db.$client.end();
  }
}

main().catch((error: unknown) => {
  console.error("Migration failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
