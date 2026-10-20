import { sql } from "drizzle-orm";
import { createDatabase, type Database } from "@/infrastructure/database/client";
import { workspaces } from "@/infrastructure/database/schema";
import { newId } from "@/lib/ids";

let shared: Database | undefined;

/** Database handle for integration tests (schema prepared by global-setup.ts). */
export function testDb(): Database {
  shared ??= createDatabase(process.env.DATABASE_URL!, { max: 5 });
  return shared;
}

export async function closeTestDb(): Promise<void> {
  await shared?.$client.end();
  shared = undefined;
}

/** Creates an isolated workspace so tests never depend on each other's data. */
export async function createTestWorkspace(
  db: Database = testDb(),
): Promise<{ id: string; slug: string }> {
  const id = newId();
  const slug = `test-${id.slice(-12)}`;
  await db.insert(workspaces).values({ id, name: `Test ${slug}`, slug });
  return { id, slug };
}

export async function truncate(db: Database, ...tables: string[]): Promise<void> {
  for (const table of tables) {
    if (!/^[a-z_]+$/.test(table)) throw new Error("bad table name");
    await db.execute(sql`truncate table ${sql.identifier(table)} cascade`);
  }
}
