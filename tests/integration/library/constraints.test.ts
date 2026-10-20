import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "@/infrastructure/database/client";
import { artifacts, fileAssets, importItems, workspaces } from "@/infrastructure/database/schema";
import { htmlDocument } from "@tests/fixtures/builders";
import { closeTestDb, testDb } from "../helpers/db";
import { createTestActor, drainJobs, newBatch, uploadFile } from "../helpers/imports";

const db = testDb();

afterAll(async () => {
  await closeDb();
  await closeTestDb();
});

async function importOne() {
  const actor = await createTestActor();
  const queued = await uploadFile(actor, (await newBatch(actor)).id, {
    filename: "constraint-check.html",
    bytes: htmlDocument({ title: "約束測試" }),
  });
  await drainJobs();
  const [item] = await db.select().from(importItems).where(eq(importItems.id, queued.id));
  return { actor, item: item! };
}

/** drizzle wraps driver errors; the Postgres message is on the cause. */
async function pgError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause;
    return `${(error as Error).message} ${cause?.message ?? ""}`;
  }
  throw new Error("expected the statement to fail");
}

describe("database-enforced invariants", () => {
  it("file_assets immutable columns cannot be updated (trigger, P-1)", async () => {
    const { item } = await importOne();
    for (const patch of [
      { sha256: "0".repeat(64) },
      { storageKey: "ws/elsewhere" },
      { byteSize: 1 },
      { originalFilename: "renamed.html" },
      { mimeType: "text/plain" },
    ]) {
      expect(
        await pgError(db.update(fileAssets).set(patch).where(eq(fileAssets.id, item.fileAssetId!))),
      ).toMatch(/immutable/);
    }
    // Integrity bookkeeping columns remain writable.
    await db
      .update(fileAssets)
      .set({ storageStatus: "missing", integrityVerifiedAt: new Date() })
      .where(eq(fileAssets.id, item.fileAssetId!));
    const [asset] = await db.select().from(fileAssets).where(eq(fileAssets.id, item.fileAssetId!));
    expect(asset?.storageStatus).toBe("missing");
  });

  it("an original still referenced by a version cannot be deleted", async () => {
    const { item } = await importOne();
    expect(
      await pgError(db.delete(fileAssets).where(eq(fileAssets.id, item.fileAssetId!))),
    ).toMatch(/foreign key/i);
  });

  it("hard-deleting an artifact removes versions but keeps the original for GC", async () => {
    const { item } = await importOne();
    await db.delete(artifacts).where(eq(artifacts.id, item.resultArtifactId!));
    const [asset] = await db.select().from(fileAssets).where(eq(fileAssets.id, item.fileAssetId!));
    expect(asset).toBeDefined();
    await db.delete(fileAssets).where(eq(fileAssets.id, item.fileAssetId!)); // now unreferenced
  });

  it("deleting a whole workspace cascades cleanly", async () => {
    const { actor, item } = await importOne();
    await db.delete(workspaces).where(eq(workspaces.id, actor.workspaceId));
    expect(
      await db.select().from(fileAssets).where(eq(fileAssets.id, item.fileAssetId!)),
    ).toHaveLength(0);
    expect(
      await db.select().from(artifacts).where(eq(artifacts.workspaceId, actor.workspaceId)),
    ).toHaveLength(0);
  });

  it("check constraints reject invalid enum values and hashes", async () => {
    const { item } = await importOne();
    expect(
      await pgError(
        db
          .update(artifacts)
          .set({ visibility: "everyone" as never })
          .where(eq(artifacts.id, item.resultArtifactId!)),
      ),
    ).toMatch(/artifacts_visibility_check/);
  });
});
