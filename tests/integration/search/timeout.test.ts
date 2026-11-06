import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as searchRoute } from "@/app/api/search/route";
import { getEnv } from "@/infrastructure/config/env";
import { closeDb, createDatabase, type Database } from "@/infrastructure/database/client";
import type { Actor } from "@/modules/auth";
import { searchArtifacts } from "@/modules/search";
import { htmlDocument } from "@tests/fixtures/builders";
import { createTestAdmin, signInOk } from "../helpers/auth";
import { closeTestDb, testDb } from "../helpers/db";
import { createTestActor, drainJobs, newBatch, uploadFile } from "../helpers/imports";

/**
 * A search runs under a statement timeout (SEARCH_TIMEOUT_MS), so it can never hold a pooled
 * connection indefinitely. The slow search is made deterministic by holding a lock it must wait
 * for: statement_timeout counts lock waits too. Without the limit, the search would wait for
 * the lock, which is only released after the search returns: the test would hang.
 */

const db = testDb();
/** One connection, so a follow-up statement provably runs on the connection the search used. */
let single: Database;
let actor: Actor;

beforeAll(async () => {
  single = createDatabase(process.env.DATABASE_URL!, { max: 1 });
  actor = await createTestActor();
  await uploadFile(actor, (await newBatch(actor)).id, {
    filename: "timeout.html",
    bytes: htmlDocument({ title: "逾時測試", body: "<p>潮間帶的觀察紀錄。</p>" }),
  });
  await drainJobs();
});

afterAll(async () => {
  await single.$client.end();
  await closeDb();
  await closeTestDb();
});

/** Runs `body` while another connection holds an ACCESS EXCLUSIVE lock on the search tables. */
async function whileLocked<T>(body: () => Promise<T>): Promise<T> {
  const blocker = await db.$client.connect();
  try {
    await blocker.query("begin");
    await blocker.query("lock table artifact_search_documents in access exclusive mode");
    return await body();
  } finally {
    await blocker.query("rollback");
    blocker.release();
  }
}

describe("search time limit", () => {
  it("finds as usual, and leaves no limit behind on the connection", async () => {
    const found = await searchArtifacts(single, actor, { q: "潮間帶" });
    expect(found.items.map((item) => item.title)).toEqual(["逾時測試"]);
    // The limit is SET LOCAL to the search's own transaction: the pooled connection is clean.
    const [setting] = (
      await single.execute<{ value: string }>(
        sql`select current_setting('statement_timeout') as value`,
      )
    ).rows;
    expect(setting!.value).toBe("0");
  });

  it("stops a search that runs past the limit with SEARCH_TIMEOUT", async () => {
    const started = Date.now();
    await whileLocked(() =>
      expect(searchArtifacts(single, actor, { q: "潮間帶", timeoutMs: 300 })).rejects.toMatchObject(
        { code: "SEARCH_TIMEOUT", status: 503 },
      ),
    );
    expect(Date.now() - started).toBeLessThan(10_000);

    // The connection is usable, without the limit, and the same search succeeds again.
    const [setting] = (
      await single.execute<{ value: string }>(
        sql`select current_setting('statement_timeout') as value`,
      )
    ).rows;
    expect(setting!.value).toBe("0");
    expect((await searchArtifacts(single, actor, { q: "潮間帶" })).items).toHaveLength(1);
  });

  it("answers the API with 503 SEARCH_TIMEOUT and a message, not a 500", async () => {
    // The route runs with the app's own limit (SEARCH_TIMEOUT_MS), so this waits it out.
    const env = getEnv();
    const admin = await createTestAdmin();
    const { cookie } = await signInOk(admin.email, admin.password);
    const response = await whileLocked(() =>
      searchRoute(
        new Request(`${env.APP_ORIGIN}/api/search?q=${encodeURIComponent("潮間帶")}`, {
          headers: { cookie },
        }),
        { params: Promise.resolve({}) },
      ),
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("SEARCH_TIMEOUT");
    expect(body.error.message).toMatch(/too long/);
  }, 30_000);
});
