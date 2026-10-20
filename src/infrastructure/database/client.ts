import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import { getEnv } from "@/infrastructure/config/env";
import { getLogger } from "@/infrastructure/observability/logger";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema> & { $client: Pool };
/** A database handle or an open transaction; services accept either. */
export type DbExecutor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

const globalForDb = globalThis as unknown as { __vaultDb?: Database };

export function createDatabase(
  connectionString: string,
  options: Partial<PoolConfig> = {},
): Database {
  const pool = new Pool({
    connectionString,
    max: options.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: process.env.SERVICE_NAME ?? "vault",
    ...options,
  });
  pool.on("error", (error) => {
    // Idle client errors (e.g. Neon autosuspend) must not crash the process.
    getLogger({ component: "db" }).error({ err: error }, "idle database client error");
  });
  return drizzle({ client: pool, schema }) as Database;
}

/**
 * Process-wide database handle. Cached on globalThis so Next.js dev hot reloads
 * do not leak connection pools.
 */
export function getDb(): Database {
  if (!globalForDb.__vaultDb) {
    const env = getEnv();
    globalForDb.__vaultDb = createDatabase(env.DATABASE_URL, { max: env.DATABASE_POOL_MAX });
  }
  return globalForDb.__vaultDb;
}

export async function closeDb(): Promise<void> {
  const db = globalForDb.__vaultDb;
  globalForDb.__vaultDb = undefined;
  await db?.$client.end();
}

export { schema };
