import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { GET as usageRoute } from "@/app/api/ops/usage/route";
import { getEnv } from "@/infrastructure/config/env";
import { closeDb } from "@/infrastructure/database/client";
import {
  artifacts,
  derivedAssets,
  exportRuns,
  fileAssets,
  importItems,
  processingJobs,
  workspaceMembers,
} from "@/infrastructure/database/schema";
import { newId } from "@/lib/ids";
import type { Actor } from "@/modules/auth";
import { requestExport, requestIntegrityCheck } from "@/modules/backup";
import { enqueueJob } from "@/modules/jobs";
import { getUsageReport } from "@/modules/ops";
import { htmlDocument, pngImage } from "@tests/fixtures/builders";
import { createTestAdmin, signInOk } from "../helpers/auth";
import { closeTestDb, testDb } from "../helpers/db";
import { createTestActor, drainJobs, newBatch, uploadFile } from "../helpers/imports";

const db = testDb();
const meta = { ipAddress: null, userAgent: "vitest" };

afterAll(async () => {
  await closeDb();
  await closeTestDb();
});

/** Bytes and counts as the tables hold them, to compare the report against. */
async function recorded(workspaceId: string) {
  const sum = async (table: typeof fileAssets | typeof derivedAssets, kind?: string) => {
    const where =
      table === derivedAssets
        ? sql`${derivedAssets.workspaceId} = ${workspaceId} and ${derivedAssets.kind} = ${kind}`
        : sql`${fileAssets.workspaceId} = ${workspaceId}`;
    const [row] = await db
      .select({
        count: sql<number>`count(*)::int`,
        bytes: sql<string>`coalesce(sum(byte_size), 0)::bigint`,
      })
      .from(table)
      .where(where);
    return { count: row!.count, bytes: Number(row!.bytes) };
  };
  return {
    originals: await sum(fileAssets),
    previewFiles: await sum(derivedAssets, "preview_file"),
    thumbnails: await sum(derivedAssets, "thumbnail"),
  };
}

async function importAll(actor: Actor, files: { filename: string; bytes: Buffer | string }[]) {
  const batch = await newBatch(actor);
  for (const file of files) await uploadFile(actor, batch.id, file);
  await drainJobs();
}

describe("usage report (FR-OPS-2/3)", () => {
  it("is empty and honest for a new workspace", async () => {
    const actor = await createTestActor();
    const report = await getUsageReport(db, actor);
    expect(report.storage).toEqual({
      originals: { count: 0, bytes: 0, missing: 0, corrupt: 0 },
      previewFiles: { count: 0, bytes: 0 },
      thumbnails: { count: 0, bytes: 0 },
      exports: { count: 0, bytes: 0 },
      totalBytes: 0,
    });
    expect(report.library).toEqual({ artifacts: 0, versions: 0 });
    expect(report.jobs.byStatus).toEqual({
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    });
    expect(report.jobs.recentFailures).toEqual([]);
    expect(report.imports).toEqual({ failed: 0, recentFailures: [] });
    expect(report.backup).toEqual({
      lastExport: null,
      latestExport: null,
      lastIntegrityCheck: null,
      latestIntegrityCheck: null,
    });
    expect(report.database.bytes).toBeGreaterThan(0);
  });

  it("adds up what the workspace stores, and nothing of other workspaces", async () => {
    const actor = await createTestActor();
    const other = await createTestActor();
    await importAll(other, [{ filename: "other.html", bytes: htmlDocument({ title: "別人的" }) }]);
    const png = await pngImage();
    const html = htmlDocument({ title: "用量" });
    await importAll(actor, [
      { filename: "usage.html", bytes: html },
      { filename: "usage.png", bytes: png },
      { filename: "broken.pdf", bytes: "this is not a pdf" },
    ]);

    const report = await getUsageReport(db, actor);
    const expected = await recorded(actor.workspaceId);
    expect(report.storage.originals).toEqual({ ...expected.originals, missing: 0, corrupt: 0 });
    // The broken PDF fails before it is stored as an original.
    expect(report.storage.originals.count).toBe(2);
    expect(report.storage.originals.bytes).toBe(png.length + Buffer.byteLength(html));
    expect(report.storage.previewFiles).toEqual(expected.previewFiles);
    expect(report.storage.thumbnails).toEqual(expected.thumbnails);
    expect(report.storage.previewFiles.count).toBeGreaterThan(0);
    expect(report.storage.thumbnails.count).toBeGreaterThan(0);
    expect(report.storage.totalBytes).toBe(
      expected.originals.bytes + expected.previewFiles.bytes + expected.thumbnails.bytes,
    );
    expect(report.library).toEqual({ artifacts: 2, versions: 2 });

    expect(report.imports.failed).toBe(1);
    expect(report.imports.recentFailures).toMatchObject([
      { filename: "broken.pdf", errorCode: "UNSUPPORTED_FILE_TYPE" },
    ]);
    // An unsupported file fails its import job permanently too; the others completed.
    expect(report.jobs.byStatus).toMatchObject({ failed: 1, completed: expect.any(Number) });
    expect(report.jobs.byStatus.completed).toBeGreaterThan(0);
    expect(report.jobs.recentFailures).toMatchObject([
      { type: "import.process_item", errorCode: "UNSUPPORTED_FILE_TYPE" },
    ]);

    // A deleted artifact leaves the library count; its original stays stored (ADR-017).
    const [first] = await db
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(eq(artifacts.workspaceId, actor.workspaceId))
      .limit(1);
    await db.update(artifacts).set({ deletedAt: new Date() }).where(eq(artifacts.id, first!.id));
    const afterDelete = await getUsageReport(db, actor);
    expect(afterDelete.library).toEqual({ artifacts: 1, versions: 1 });
    expect(afterDelete.storage.originals.count).toBe(2);

    // Missing and corrupt originals are reported as recorded by integrity checks.
    const assets = await db
      .select({ id: fileAssets.id })
      .from(fileAssets)
      .where(eq(fileAssets.workspaceId, actor.workspaceId));
    await db
      .update(fileAssets)
      .set({ storageStatus: "missing" })
      .where(eq(fileAssets.id, assets[0]!.id));
    await db
      .update(fileAssets)
      .set({ storageStatus: "corrupt" })
      .where(eq(fileAssets.id, assets[1]!.id));
    expect((await getUsageReport(db, actor)).storage.originals).toMatchObject({
      missing: 1,
      corrupt: 1,
    });
  });

  it("reports jobs by status and the most recent failures, newest first, cut short", async () => {
    const actor = await createTestActor();
    const ids: string[] = [];
    for (const [index, status] of (["failed", "failed", "queued"] as const).entries()) {
      const { job } = await enqueueJob(db, {
        type: "export.create",
        idempotencyKey: `usage-test:${newId()}`,
        workspaceId: actor.workspaceId,
      });
      ids.push(job.id);
      await db
        .update(processingJobs)
        .set({
          status,
          errorCode: status === "failed" ? "EXPORT_FAILED" : null,
          lastError: status === "failed" ? `${"x".repeat(400)}-${index}` : null,
          updatedAt: new Date(Date.now() + index * 1000),
        })
        .where(eq(processingJobs.id, job.id));
    }
    const report = await getUsageReport(db, actor);
    expect(report.jobs.byStatus).toMatchObject({ failed: 2, queued: 1 });
    expect(report.jobs.recentFailures.map((job) => job.id)).toEqual([ids[1], ids[0]]);
    expect(report.jobs.recentFailures[0]).toMatchObject({
      type: "export.create",
      errorCode: "EXPORT_FAILED",
    });
    expect(report.jobs.recentFailures[0]!.error).toHaveLength(301);
    expect(report.jobs.recentFailures[0]!.error!.endsWith("…")).toBe(true);
    // Another workspace sees none of it.
    expect((await getUsageReport(db, await createTestActor())).jobs.byStatus.failed).toBe(0);
  });

  it("dates failures by when they failed, not by later bookkeeping", async () => {
    const actor = await createTestActor();
    await importAll(actor, [
      { filename: "old.pdf", bytes: "not a pdf" },
      { filename: "new.pdf", bytes: "not a pdf either" },
    ]);
    const hour = 60 * 60 * 1000;
    const items = await db
      .select({ id: importItems.id, filename: importItems.originalFilename })
      .from(importItems)
      .where(eq(importItems.workspaceId, actor.workspaceId));
    const id = (name: string) => items.find((item) => item.filename === name)!.id;
    const oldFailure = new Date(Date.now() - 10 * 24 * hour);
    await db
      .update(importItems)
      .set({ completedAt: oldFailure })
      .where(eq(importItems.id, id("old.pdf")));
    await db
      .update(importItems)
      .set({ completedAt: new Date(Date.now() - hour) })
      .where(eq(importItems.id, id("new.pdf")));
    // Staging cleanup of the old failure, days later, refreshes its updatedAt.
    await db
      .update(importItems)
      .set({ stagingCleanedAt: new Date() })
      .where(eq(importItems.id, id("old.pdf")));

    const jobs = await db
      .select({ id: processingJobs.id, payload: processingJobs.payload })
      .from(processingJobs)
      .where(
        and(eq(processingJobs.workspaceId, actor.workspaceId), eq(processingJobs.status, "failed")),
      );
    expect(jobs).toHaveLength(2);
    const [olderJob, newerJob] = jobs;
    await db
      .update(processingJobs)
      .set({ completedAt: oldFailure, updatedAt: new Date() })
      .where(eq(processingJobs.id, olderJob!.id));
    await db
      .update(processingJobs)
      .set({ completedAt: new Date(Date.now() - hour), updatedAt: new Date(Date.now() - hour) })
      .where(eq(processingJobs.id, newerJob!.id));

    const report = await getUsageReport(db, actor);
    expect(report.imports.recentFailures.map((item) => item.filename)).toEqual([
      "new.pdf",
      "old.pdf",
    ]);
    expect(report.imports.recentFailures[1]!.failedAt).toEqual(oldFailure);
    expect(report.jobs.recentFailures.map((job) => job.id)).toEqual([newerJob!.id, olderJob!.id]);
    expect(report.jobs.recentFailures[1]!.failedAt).toEqual(oldFailure);
  });

  it("reports the last export and integrity check, and the latest attempts", async () => {
    const actor = await createTestActor();
    await importAll(actor, [{ filename: "backup.html", bytes: htmlDocument({ title: "備份" }) }]);
    const exported = await requestExport(db, actor, meta);
    await requestIntegrityCheck(db, actor.workspaceId);
    await drainJobs();

    const report = await getUsageReport(db, actor);
    const [run] = await db.select().from(exportRuns).where(eq(exportRuns.id, exported.id));
    expect(run!.status).toBe("completed");
    expect(report.backup.lastExport).toEqual({
      id: exported.id,
      completedAt: run!.completedAt,
      bytes: run!.byteSize,
    });
    expect(report.backup.latestExport).toMatchObject({ id: exported.id, status: "completed" });
    expect(report.storage.exports).toEqual({ count: 1, bytes: run!.byteSize });
    expect(report.backup.lastIntegrityCheck).toMatchObject({ checked: 1, ok: 1, missing: 0 });
    expect(report.backup.latestIntegrityCheck?.id).toBe(report.backup.lastIntegrityCheck?.id);

    // A newer attempt that failed shows as the latest, while the last success stays.
    const failed = await requestExport(db, actor, meta);
    await db.update(exportRuns).set({ status: "failed" }).where(eq(exportRuns.id, failed.id));
    const later = await getUsageReport(db, actor);
    expect(later.backup.lastExport?.id).toBe(exported.id);
    expect(later.backup.latestExport).toMatchObject({ id: failed.id, status: "failed" });

    // An archive deleted by retention no longer counts as stored.
    await db.update(exportRuns).set({ storageKey: null }).where(eq(exportRuns.id, exported.id));
    expect((await getUsageReport(db, actor)).storage.exports).toEqual({ count: 0, bytes: 0 });
  });
});

describe("GET /api/ops/usage", () => {
  const call = (cookie: string) =>
    usageRoute(new Request(`${getEnv().APP_ORIGIN}/api/ops/usage`, { headers: { cookie } }), {
      params: Promise.resolve({}),
    });

  it("answers owners only", async () => {
    const owner = await createTestAdmin();
    const { cookie } = await signInOk(owner.email, owner.password);
    const response = await call(cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { storage: { totalBytes: number } };
    expect(body.storage.totalBytes).toBe(0);

    for (const role of ["editor", "viewer"] as const) {
      const member = await createTestAdmin();
      await db
        .update(workspaceMembers)
        .set({ workspaceId: owner.workspaceId, role })
        .where(eq(workspaceMembers.userId, member.userId));
      const signedIn = await signInOk(member.email, member.password);
      expect((await call(signedIn.cookie)).status, role).toBe(403);
    }
    expect((await call("")).status).toBe(401);
  });
});
