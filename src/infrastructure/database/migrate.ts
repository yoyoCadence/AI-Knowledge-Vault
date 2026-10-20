import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Database } from "./client";

export const MIGRATIONS_FOLDER = path.resolve(process.cwd(), "drizzle");

/** Applies pending versioned migrations from `drizzle/` (ADR-003). Never uses `push`. */
export async function runMigrations(
  db: Database,
  migrationsFolder = MIGRATIONS_FOLDER,
): Promise<void> {
  await migrate(db, { migrationsFolder });
}
