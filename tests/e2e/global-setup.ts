import { rm } from "node:fs/promises";
import { Client } from "pg";
import { e2eEnv, E2E_ADMIN } from "./e2e-env";

/** Fresh E2E database + storage, all migrations, one admin (TEST_PLAN §5). */
export default async function globalSetup(): Promise<void> {
  Object.assign(process.env, e2eEnv);
  const url = e2eEnv.DATABASE_URL!;
  if (!/e2e|test/i.test(new URL(url).pathname))
    throw new Error("Refusing to reset a non-test database");

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("drop schema if exists public cascade");
    await client.query("drop schema if exists drizzle cascade");
    await client.query("create schema public");
  } finally {
    await client.end();
  }
  await rm(e2eEnv.LOCAL_STORAGE_DIR!, { recursive: true, force: true });

  // Imported after env is set: modules read configuration lazily.
  const { createDatabase } = await import("../../src/infrastructure/database/client");
  const { runMigrations } = await import("../../src/infrastructure/database/migrate");
  const { createAdmin } = await import("../../src/modules/auth/admin");
  const db = createDatabase(url, { max: 1 });
  try {
    await runMigrations(db);
    await createAdmin(db, E2E_ADMIN);
  } finally {
    await db.$client.end();
  }
}
