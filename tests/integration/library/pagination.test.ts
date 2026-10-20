import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "@/infrastructure/database/client";
import { artifacts, importBatches } from "@/infrastructure/database/schema";
import type { KeysetCursor } from "@/lib/cursor";
import { newId } from "@/lib/ids";
import { listArtifacts } from "@/modules/artifacts";
import { listBatches } from "@/modules/imports";
import { closeTestDb, testDb } from "../helpers/db";
import { createTestActor } from "../helpers/imports";

const db = testDb();

afterAll(async () => {
  await closeDb();
  await closeTestDb();
});

// Three rows inside one millisecond: a millisecond-precision cursor would skip two of them.
const SAME_MILLISECOND = [
  "2026-01-02T03:04:05.678300Z",
  "2026-01-02T03:04:05.678200Z",
  "2026-01-02T03:04:05.678100Z",
];

async function pageThrough<T extends { id: string }>(
  fetch: (cursor?: KeysetCursor) => Promise<{ items: T[]; nextCursor: KeysetCursor | null }>,
) {
  const seen: string[] = [];
  let cursor: KeysetCursor | undefined;
  for (let page = 0; page < 10; page += 1) {
    const result = await fetch(cursor);
    seen.push(...result.items.map((item) => item.id));
    if (!result.nextCursor) return seen;
    cursor = result.nextCursor;
  }
  throw new Error("pagination did not terminate");
}

describe("keyset pagination at microsecond precision", () => {
  it("listArtifacts returns every row created within the same millisecond", async () => {
    const actor = await createTestActor();
    const ids = SAME_MILLISECOND.map(() => newId());
    for (const [index, id] of ids.entries()) {
      await db.insert(artifacts).values({
        id,
        workspaceId: actor.workspaceId,
        title: `same-ms ${index}`,
        createdAt: sql`${SAME_MILLISECOND[index]}::timestamptz` as unknown as Date,
      });
    }
    const seen = await pageThrough((cursor) => listArtifacts(db, actor, { limit: 1, cursor }));
    expect(seen).toEqual(ids);
  });

  it("listBatches returns every row created within the same millisecond", async () => {
    const actor = await createTestActor();
    const ids = SAME_MILLISECOND.map(() => newId());
    for (const [index, id] of ids.entries()) {
      await db.insert(importBatches).values({
        id,
        workspaceId: actor.workspaceId,
        createdBy: actor.userId,
        createdAt: sql`${SAME_MILLISECOND[index]}::timestamptz` as unknown as Date,
      });
    }
    const seen = await pageThrough((cursor) => listBatches(db, actor, { limit: 1, cursor }));
    expect(seen).toEqual(ids);
  });
});
