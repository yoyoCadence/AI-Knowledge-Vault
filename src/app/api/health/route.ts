import { sql } from "drizzle-orm";
import { getDb } from "@/infrastructure/database/client";
import { getStorage } from "@/infrastructure/storage";
import { APP_VERSION } from "@/lib/version";
import { json } from "../_lib/http";

export const dynamic = "force-dynamic";

async function check(fn: () => Promise<unknown>): Promise<"ok" | "error"> {
  try {
    await fn();
    return "ok";
  } catch {
    return "error";
  }
}

/** Liveness/readiness probe. Unauthenticated; reveals no configuration (API_CONTRACT §2). */
export async function GET(): Promise<Response> {
  const [db, storage] = await Promise.all([
    check(() => getDb().execute(sql`select 1`)),
    check(() => getStorage().headObject("health/probe")),
  ]);
  const status = db === "ok" && storage === "ok" ? "ok" : "degraded";
  return json(
    { status, db, storage, version: APP_VERSION },
    { status: status === "ok" ? 200 : 503 },
  );
}
