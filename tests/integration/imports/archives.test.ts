import { createHash } from "node:crypto";
import { text } from "node:stream/consumers";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "@/infrastructure/database/client";
import {
  artifactVersions,
  derivedAssets,
  importItems,
  processingJobs,
} from "@/infrastructure/database/schema";
import { getStorage } from "@/infrastructure/storage";
import { AppError } from "@/lib/errors";
import { createOriginalDownload, getArtifactDetail } from "@/modules/artifacts";
import {
  cleanupImports,
  declareItem,
  getBatchReport,
  importLimitsFromEnv,
  isRetryable,
  listBatches,
  retryItem,
  toItemDto,
} from "@/modules/imports";
import { claimJobs, enqueueJob } from "@/modules/jobs";
import { enqueueDueMaintenance } from "@/worker/scheduler";
import { getEnv } from "@/infrastructure/config/env";
import {
  claudeDesignZipEntries,
  htmlDocument,
  markdownDocument,
  pdfDocument,
  pngImage,
} from "@tests/fixtures/builders";
import { buildZip } from "@tests/fixtures/zip";
import { closeTestDb, testDb } from "../helpers/db";
import { createTestActor, drainJobs, newBatch, uploadFile } from "../helpers/imports";

const db = testDb();
const meta = { ipAddress: null, userAgent: "vitest" };
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

afterAll(async () => {
  await closeDb();
  await closeTestDb();
});

async function itemById(id: string) {
  const [row] = await db.select().from(importItems).where(eq(importItems.id, id));
  return row!;
}

describe("ZIP imports (P1A-ZIP)", () => {
  it("imports a Claude Design export: entry text, .thumbnail cover, script-free preview site", async () => {
    const actor = await createTestActor();
    const zip = buildZip(await claudeDesignZipEntries());
    const queued = await uploadFile(actor, (await newBatch(actor)).id, {
      filename: "Urban_Heat_Report_Design.zip",
      bytes: zip,
    });
    await drainJobs();

    const item = await itemById(queued.id);
    expect(item).toMatchObject({
      status: "succeeded",
      outcome: "new_artifact",
      detectedType: "zip",
    });
    const { artifact, versions } = await getArtifactDetail(db, actor, item.resultArtifactId!);
    expect(artifact.title).toBe("城市沒有恆溫器，只有材料");
    expect(versions[0]).toMatchObject({
      contentKind: "claude_design_document",
      previewKind: "static_site",
      previewStatus: "ready",
      sourcePlatform: "claude_design",
    });

    const [version] = await db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.id, item.resultVersionId!));
    expect(version?.previewEntryPath).toBe("Urban Heat Report.dc.html");
    expect(version?.analysis).toMatchObject({
      archive: { kind: "claude_design", entryCount: 7 },
      externalDependencies: ["fonts.googleapis.com"],
    });

    const derived = await db
      .select()
      .from(derivedAssets)
      .where(eq(derivedAssets.artifactVersionId, version!.id));
    expect(derived.filter((asset) => asset.kind === "thumbnail")).toHaveLength(1);
    const previewPaths = derived
      .filter((asset) => asset.kind === "preview_file")
      .map((asset) => asset.path)
      .sort();
    expect(previewPaths).toContain("Urban Heat Report.dc.html");
    expect(previewPaths).toContain("_ds/modernist/styles.css");
    // Every preview file's stored bytes match its recorded hash.
    for (const asset of derived) {
      const { body } = await getStorage().getObject(asset.storageKey);
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(chunk as Buffer);
      expect(sha256(Buffer.concat(chunks))).toBe(asset.sha256);
    }
    const css = derived.find((asset) => asset.path === "_ds/modernist/styles.css")!;
    expect(await text((await getStorage().getObject(css.storageKey)).body)).toContain("--color-bg");
  });

  it("a hostile ZIP fails with ARCHIVE_REJECTED but its original is preserved for inspection", async () => {
    const actor = await createTestActor();
    const evil = buildZip([
      { name: "index.html", data: htmlDocument() },
      { name: "../../../tmp/owned.txt", data: "pwned" },
    ]);
    const queued = await uploadFile(actor, (await newBatch(actor)).id, {
      filename: "evil-traversal.zip",
      bytes: evil,
    });
    await drainJobs();
    const item = await itemById(queued.id);
    expect(item).toMatchObject({ status: "failed", errorCode: "ARCHIVE_REJECTED" });
    expect(item.errorMessage).toMatch(/ZIP_ENTRY_PATH_TRAVERSAL.*preserved/);
    expect(item.resultArtifactId).not.toBeNull();

    const { versions } = await getArtifactDetail(db, actor, item.resultArtifactId!);
    expect(versions[0]).toMatchObject({
      contentKind: "archive_other",
      previewKind: "unsupported",
      processingStatus: "failed",
    });
    const derived = await db
      .select()
      .from(derivedAssets)
      .where(eq(derivedAssets.artifactVersionId, item.resultVersionId!));
    expect(derived).toHaveLength(0);
    const download = await createOriginalDownload(
      db,
      getStorage(),
      actor,
      { artifactId: item.resultArtifactId!, versionId: item.resultVersionId! },
      meta,
    );
    expect(download.sha256).toBe(sha256(evil));

    // Final: re-running would only rediscover its own preserved original.
    expect(isRetryable(item)).toBe(false);
    expect(toItemDto(item).retryable).toBe(false);
    await expect(retryItem(db, getStorage(), actor, item.batchId, item.id)).rejects.toSatisfy(
      (error: unknown) => error instanceof AppError && error.code === "NOT_RETRYABLE",
    );
  });

  it("a size lie in a preview asset (found only while streaming) still preserves the original", async () => {
    const actor = await createTestActor();
    const entries = (await claudeDesignZipEntries()).map((entry) =>
      entry.name === "_ds/modernist/styles.css"
        ? { ...entry, data: "body{margin:0}".repeat(400), declaredSize: 20 }
        : entry,
    );
    const liar = buildZip(entries);
    const queued = await uploadFile(actor, (await newBatch(actor)).id, {
      filename: "late-liar.zip",
      bytes: liar,
    });
    await drainJobs();
    const item = await itemById(queued.id);
    expect(item).toMatchObject({ status: "failed", errorCode: "ARCHIVE_REJECTED" });
    expect(item.errorMessage).toMatch(/ZIP_SIZE_MISMATCH.*preserved/);
    expect(item.fileAssetId).not.toBeNull();
    expect(item.resultVersionId).not.toBeNull();

    const [version] = await db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.id, item.resultVersionId!));
    expect(version).toMatchObject({ previewKind: "unsupported", previewEntryPath: null });
    const previews = await db
      .select()
      .from(derivedAssets)
      .where(
        and(
          eq(derivedAssets.artifactVersionId, item.resultVersionId!),
          eq(derivedAssets.kind, "preview_file"),
        ),
      );
    expect(previews).toHaveLength(0);
    const download = await createOriginalDownload(
      db,
      getStorage(),
      actor,
      { artifactId: item.resultArtifactId!, versionId: item.resultVersionId! },
      meta,
    );
    expect(download.sha256).toBe(sha256(liar));
  });

  it("a zip bomb is rejected without decompressing it", async () => {
    const actor = await createTestActor();
    const bomb = buildZip([
      { name: "zeros.html", data: Buffer.alloc(8 * 1024 * 1024, 0x20), method: "deflate" },
    ]);
    expect(bomb.length).toBeLessThan(64 * 1024);
    const queued = await uploadFile(actor, (await newBatch(actor)).id, {
      filename: "bomb.zip",
      bytes: bomb,
    });
    await drainJobs();
    const item = await itemById(queued.id);
    expect(item).toMatchObject({ status: "failed", errorCode: "ARCHIVE_REJECTED" });
    expect(item.errorMessage).toMatch(/ZIP_COMPRESSION_RATIO/);
  });

  it("a framework source project is preserved with BUILD_REQUIRED and never built", async () => {
    const actor = await createTestActor();
    const project = buildZip([
      {
        name: "my-app/package.json",
        data: JSON.stringify({
          name: "my-app",
          scripts: { build: "vite build", postinstall: "node evil.js" },
        }),
      },
      { name: "my-app/vite.config.ts", data: "export default {}" },
      {
        name: "my-app/src/main.tsx",
        data: "createRoot(document.getElementById('root')).render(<App/>)",
      },
      { name: "my-app/README.md", data: markdownDocument() },
    ]);
    const queued = await uploadFile(actor, (await newBatch(actor)).id, {
      filename: "my-react-app.zip",
      bytes: project,
    });
    await drainJobs();
    const item = await itemById(queued.id);
    expect(item.status).toBe("succeeded");
    expect(item.warnings.join()).toMatch(/BUILD_REQUIRED/);
    const { versions } = await getArtifactDetail(db, actor, item.resultArtifactId!);
    expect(versions[0]).toMatchObject({
      contentKind: "framework_project",
      previewKind: "framework_source",
    });
  });
});

describe("batch of 50 (Phase 1A exit criterion 4) with partial failures (criterion 7)", () => {
  it("processes 50 small valid works plus broken files; failures stay isolated", async () => {
    const actor = await createTestActor();
    const batch = await newBatch(actor);
    const png = await pngImage(64, 48);
    const files: { filename: string; bytes: Buffer | string }[] = [];
    for (let index = 0; index < 50; index += 1) {
      const kind = index % 6;
      const label = `批次作品-${String(index).padStart(2, "0")}`;
      if (kind === 0)
        files.push({
          filename: `batch-html-${index}.html`,
          bytes: htmlDocument({ title: label, body: `<p>${label} 的研究內容與證據整理。</p>` }),
        });
      else if (kind === 1)
        files.push({
          filename: `batch-md-${index}.md`,
          bytes: `# ${label}\n\n內容 ${index}：動能與反轉效應。`,
        });
      else if (kind === 2)
        files.push({
          filename: `batch-txt-${index}.txt`,
          bytes: `${label}\n\n純文字研究筆記 ${index}`,
        });
      else if (kind === 3)
        files.push({
          filename: `batch-pdf-${index}.pdf`,
          bytes: pdfDocument([`Batch PDF number ${index}`], `Batch PDF ${index}`),
        });
      else if (kind === 4)
        files.push({
          filename: `batch-site-${index}.zip`,
          bytes: buildZip([
            {
              name: "index.html",
              data: htmlDocument({ title: label, body: `<p>網站 ${index}</p>` }),
            },
            { name: "style.css", data: "body{}" },
          ]),
        });
      else
        files.push({
          filename: `batch-img-${index}.png`,
          bytes: Buffer.concat([png, Buffer.from([index])]),
        });
    }
    files.push({ filename: "broken.pdf", bytes: "%PDX not really a pdf" });
    files.push({
      filename: "broken-archive.zip",
      bytes: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("garbage")]),
    });

    const started = Date.now();
    for (const file of files) await uploadFile(actor, batch.id, file);
    await drainJobs({ concurrency: 3 });
    const elapsed = Date.now() - started;

    const report = await getBatchReport(db, actor, batch.id);
    expect(report.counts.total).toBe(52);
    expect(report.counts.succeeded).toBe(50);
    expect(report.counts.failed).toBe(2);
    expect(report.batch.status).toBe("completed_with_errors");
    const failed = report.items
      .filter((item) => item.status === "failed")
      .map((item) => [item.originalFilename, item.errorCode]);
    expect(failed).toEqual(
      expect.arrayContaining([
        ["broken.pdf", "UNSUPPORTED_FILE_TYPE"],
        ["broken-archive.zip", "ARCHIVE_REJECTED"],
      ]),
    );
    expect(elapsed).toBeLessThan(60_000);

    // The recent-imports listing aggregates the same counts (regression: correlated subquery bug).
    const {
      items: [listed],
    } = await listBatches(db, actor, { limit: 5 });
    expect(listed).toMatchObject({
      id: batch.id,
      total: 52,
      failed: 2,
      status: "completed_with_errors",
    });
  }, 120_000);
});

describe("maintenance (P1A-RECOVERY)", () => {
  it("expires abandoned uploads and deletes their staged bytes later", async () => {
    const actor = await createTestActor();
    const batch = await newBatch(actor);
    const { item } = await declareItem(
      db,
      getStorage(),
      actor,
      batch.id,
      { filename: "abandoned.txt", size: 5 },
      importLimitsFromEnv(getEnv()),
    );
    await getStorage().putObject(item.stagingKey, Buffer.from("hello"));

    const later = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const first = await cleanupImports(db, getStorage(), { now: later });
    expect(first.expired).toBeGreaterThanOrEqual(1);
    expect(await itemById(item.id)).toMatchObject({
      status: "expired",
      errorCode: "UPLOAD_EXPIRED",
    });
    expect((await getBatchReport(db, actor, batch.id)).batch.status).toBe("completed");

    const muchLater = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    await cleanupImports(db, getStorage(), { now: muchLater });
    expect(await getStorage().headObject(item.stagingKey)).toBeNull();
    expect((await itemById(item.id)).stagingCleanedAt).not.toBeNull();
  });

  it("reconciles items whose job died after its lease expired (no attempts left)", async () => {
    const actor = await createTestActor();
    const queued = await uploadFile(actor, (await newBatch(actor)).id, {
      filename: "orphan-candidate.md",
      bytes: "# Orphan\n\ntext",
    });
    // Simulate a crashed worker: claim the job, mark the item processing, then expire the lease with no attempts left.
    await db
      .update(processingJobs)
      .set({ maxAttempts: 1 })
      .where(sql`${processingJobs.payload}->>'itemId' = ${queued.id}`);
    await claimJobs(db, {
      workerId: "crashed-worker",
      limit: 50,
      leaseSeconds: 1,
      types: ["import.process_item"],
    });
    await db.update(importItems).set({ status: "processing" }).where(eq(importItems.id, queued.id));
    await db
      .update(processingJobs)
      .set({
        status: "failed",
        errorCode: "LEASE_EXPIRED",
        lastError: "worker lease expired before completion",
        lockedBy: null,
      })
      .where(sql`${processingJobs.payload}->>'itemId' = ${queued.id}`);

    const report = await cleanupImports(db, getStorage());
    expect(report.reconciled).toBeGreaterThanOrEqual(1);
    expect(await itemById(queued.id)).toMatchObject({
      status: "failed",
      errorCode: "LEASE_EXPIRED",
    });

    // And the user can retry it successfully.
    const batchId = (await itemById(queued.id)).batchId;
    await retryItem(db, getStorage(), actor, batchId, queued.id);
    await drainJobs();
    expect((await itemById(queued.id)).status).toBe("succeeded");
  });

  it("prunes old finished jobs and schedules maintenance idempotently", async () => {
    const old = await enqueueJob(db, { type: "test.old", idempotencyKey: `old-${Date.now()}` });
    await db
      .update(processingJobs)
      .set({ status: "completed", completedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) })
      .where(eq(processingJobs.id, old.job.id));
    const report = await cleanupImports(db, getStorage());
    expect(report.jobsPruned).toBeGreaterThanOrEqual(1);
    expect(
      await db.select().from(processingJobs).where(eq(processingJobs.id, old.job.id)),
    ).toHaveLength(0);

    const now = new Date();
    const first = await enqueueDueMaintenance(db, now);
    const second = await enqueueDueMaintenance(db, now);
    expect(second).toBe(0);
    expect(first).toBeLessThanOrEqual(1);
    const scheduled = await db
      .select()
      .from(processingJobs)
      .where(and(eq(processingJobs.type, "maintenance.cleanup_imports")));
    expect(scheduled.length).toBeGreaterThanOrEqual(1);
  });
});
