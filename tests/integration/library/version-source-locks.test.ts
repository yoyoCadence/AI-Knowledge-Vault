import { eq } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "@/infrastructure/database/client";
import { artifactVersions } from "@/infrastructure/database/schema";
import { updateVersionSource } from "@/modules/artifacts";
import { indexVersion } from "@/modules/search";
import { htmlDocument } from "@tests/fixtures/builders";
import { closeTestDb, testDb } from "../helpers/db";
import { createTestActor, drainJobs, newBatch, uploadFile } from "../helpers/imports";

const db = testDb();
const meta = { ipAddress: null, userAgent: "vitest" };

afterAll(async () => {
  await closeDb();
  await closeTestDb();
});

/** Resolves once `count` sessions wait on a lock (polling pg_stat_activity), or throws. */
async function lockWaiters(watcher: Client, count: number) {
  for (const deadline = Date.now() + 10_000; ;) {
    const { rows } = await watcher.query<{ n: number }>(
      "select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()",
    );
    if (rows[0]!.n >= count) return;
    if (Date.now() > deadline) throw new Error(`fewer than ${count} sessions waited on a lock`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("source edits and the search index job (lock order)", () => {
  it("take the version, then the artifact, so they cannot deadlock", async () => {
    const actor = await createTestActor();
    const item = await uploadFile(actor, (await newBatch(actor)).id, {
      filename: "locks.html",
      bytes: htmlDocument({ title: "鎖順序" }),
    });
    await drainJobs();
    const [version] = await db
      .select({ id: artifactVersions.id, artifactId: artifactVersions.artifactId })
      .from(artifactVersions)
      .where(eq(artifactVersions.importItemId, item.id));

    const blocker = new Client({ connectionString: process.env.DATABASE_URL });
    const watcher = new Client({ connectionString: process.env.DATABASE_URL });
    await blocker.connect();
    await watcher.connect();
    try {
      // Another artifact writer (a note, a tag) holds the artifact for a moment.
      await blocker.query("begin");
      await blocker.query("select id from artifacts where id = $1 for update", [
        version!.artifactId,
      ]);
      const edit = updateVersionSource(
        db,
        actor,
        { artifactId: version!.artifactId, versionId: version!.id },
        { author: "鎖測試" },
        meta,
      );
      await lockWaiters(watcher, 1);
      // The index job for the same version, as after an import or a re-extraction.
      const index = indexVersion(db, version!.id);
      await lockWaiters(watcher, 2);
      await blocker.query("rollback");
      // In the other lock order one of them fails with "deadlock detected".
      const [edited, indexed] = await Promise.allSettled([edit, index]);
      expect(edited.status).toBe("fulfilled");
      expect(indexed.status).toBe("fulfilled");
    } finally {
      await blocker.end();
      await watcher.end();
    }
  });
});
