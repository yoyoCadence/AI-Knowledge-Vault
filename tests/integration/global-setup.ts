import { rm } from "node:fs/promises";
import { Client } from "pg";
import { createDatabase } from "@/infrastructure/database/client";
import { runMigrations } from "@/infrastructure/database/migrate";
import { testEnv } from "../test-env";

/**
 * Recreates the test database schema from scratch and applies every migration, proving on each
 * run that migrations work on an empty database (DATA_MODEL §6 step 6).
 */
export default async function setup(): Promise<void> {
  const url = testEnv.DATABASE_URL;
  if (!/test/i.test(new URL(url).pathname)) {
    throw new Error("Refusing to reset a database whose name does not contain 'test'");
  }

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("drop schema if exists public cascade");
    await client.query("drop schema if exists drizzle cascade");
    await client.query("create schema public");
  } finally {
    await client.end();
  }

  const db = createDatabase(url, { max: 1 });
  try {
    await runMigrations(db);
  } finally {
    await db.$client.end();
  }

  await rm(testEnv.LOCAL_STORAGE_DIR, { recursive: true, force: true });
}
