import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "@/infrastructure/database/client";
import {
  artifacts,
  artifactVersions,
  exportRuns,
  fileAssets,
  integrityChecks,
} from "@/infrastructure/database/schema";
import type { Actor } from "@/modules/auth";
import { requestExport, requestIntegrityCheck } from "@/modules/backup";
import { getLibrarySummary, getUsageReport } from "@/modules/ops";
import { htmlDocument } from "@tests/fixtures/builders";
import { closeTestDb, testDb } from "../helpers/db";
import { createTestActor, drainJobs, newBatch, uploadFile } from "../helpers/imports";

const db = testDb();
const meta = { ipAddress: null, userAgent: "vitest" };

afterAll(async () => {
  await closeDb();
  await closeTestDb();
});

/** Imports one file and waits for it; returns its artifact and version. */
async function importOne(actor: Actor, filename: string, bytes: string | Buffer) {
  const item = await uploadFile(actor, (await newBatch(actor)).id, { filename, bytes });
  await drainJobs();
  const [version] = await db
    .select({ id: artifactVersions.id, artifactId: artifactVersions.artifactId })
    .from(artifactVersions)
    .where(eq(artifactVersions.importItemId, item.id));
  return version!;
}

describe("getLibrarySummary (FR-LIB-1)", () => {
  it("counts works, versions and kinds of the live library, from the usage report's queries", async () => {
    const actor = await createTestActor();
    const empty = await getLibrarySummary(db, actor);
    expect(empty).toEqual({
      library: { artifacts: 0, versions: 0 },
      kinds: [],
      originals: { count: 0, bytes: 0, missing: 0, corrupt: 0 },
      lastExportAt: null,
      lastIntegrityCheckAt: null,
    });

    const first = await importOne(actor, "lagoon-report.html", htmlDocument({ title: "潟湖" }));
    // Same stem: a second version of the first work.
    await importOne(actor, "lagoon-report (1).html", htmlDocument({ title: "潟湖 v2" }));
    const other = await importOne(actor, "reef-notes.html", htmlDocument({ title: "礁岩" }));
    await importOne(actor, "tide-table.md", "# 潮汐表\n\n每日潮汐。\n");
    // A work whose current version is markdown, though it started as HTML: its kind is the
    // current version's.
    const mixed = await importOne(actor, "mixed-kinds.html", htmlDocument({ title: "混合" }));
    const mixedV2 = await importOne(
      actor,
      "mixed-kinds (1).md",
      "# 混合 v2\n\n改寫成 Markdown。\n",
    );
    expect(mixedV2.artifactId).toBe(mixed.artifactId);

    const summary = await getLibrarySummary(db, actor);
    expect(summary.library).toEqual({ artifacts: 4, versions: 6 });
    expect(summary.kinds).toEqual([
      { kind: "html_document", count: 2 },
      { kind: "markdown", count: 2 },
    ]);
    const stored = await db
      .select({ byteSize: fileAssets.byteSize })
      .from(fileAssets)
      .where(eq(fileAssets.workspaceId, actor.workspaceId));
    expect(summary.originals).toEqual({
      count: 6,
      bytes: stored.reduce((sum, row) => sum + row.byteSize, 0),
      missing: 0,
      corrupt: 0,
    });

    // A deleted work leaves the counts; its originals are still stored, and still counted.
    await db
      .update(artifacts)
      .set({ deletedAt: new Date() })
      .where(eq(artifacts.id, other.artifactId));
    // What integrity checks found is shown as found.
    const [firstFile] = await db
      .select({ id: artifactVersions.primaryFileId })
      .from(artifactVersions)
      .where(eq(artifactVersions.id, first.id));
    await db
      .update(fileAssets)
      .set({ storageStatus: "corrupt" })
      .where(eq(fileAssets.id, firstFile!.id));
    const after = await getLibrarySummary(db, actor);
    expect(after.library).toEqual({ artifacts: 3, versions: 5 });
    expect(after.kinds).toEqual([
      { kind: "markdown", count: 2 },
      { kind: "html_document", count: 1 },
    ]);
    expect(after.originals).toMatchObject({ count: 6, missing: 0, corrupt: 1 });

    // The usage page reads the same numbers.
    const report = await getUsageReport(db, actor);
    expect(after.library).toEqual(report.library);
    expect(after.originals).toEqual(report.storage.originals);

    // Another workspace sees none of it.
    expect((await getLibrarySummary(db, await createTestActor())).library).toEqual({
      artifacts: 0,
      versions: 0,
    });
  });

  it("dates the last completed export and integrity check, the workspace's own", async () => {
    const actor = await createTestActor();
    await importOne(actor, "kept.html", htmlDocument({ title: "保存" }));
    const exported = await requestExport(db, actor, meta);
    await requestIntegrityCheck(db, actor.workspaceId);
    await drainJobs();
    const [run] = await db.select().from(exportRuns).where(eq(exportRuns.id, exported.id));
    const [check] = await db
      .select()
      .from(integrityChecks)
      .where(eq(integrityChecks.workspaceId, actor.workspaceId));
    expect(run!.status).toBe("completed");
    expect(check!.status).toBe("completed");

    const summary = await getLibrarySummary(db, actor);
    expect(summary.lastExportAt).toEqual(run!.completedAt);
    expect(summary.lastIntegrityCheckAt).toEqual(check!.completedAt);
    const report = await getUsageReport(db, actor);
    expect(summary.lastExportAt).toEqual(report.backup.lastExport?.completedAt);
    expect(summary.lastIntegrityCheckAt).toEqual(report.backup.lastIntegrityCheck?.completedAt);

    // A newer attempt that has not completed does not move the dates; nor does another
    // workspace's.
    await requestExport(db, actor, meta);
    const elsewhere = await createTestActor();
    const later = new Date(Date.now() + 60_000);
    await db.insert(integrityChecks).values({
      workspaceId: elsewhere.workspaceId,
      status: "completed",
      checkedCount: 1,
      okCount: 1,
      startedAt: later,
      completedAt: later,
    });
    expect(await getLibrarySummary(db, actor)).toEqual(summary);
  });
});
