import { createHash } from "node:crypto";
import { text } from "node:stream/consumers";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  artifactFiles,
  artifacts,
  artifactVersions,
  auditLogs,
  derivedAssets,
  documentSections,
  extractedDocuments,
  fileAssets,
  importItems,
  processingJobs,
} from "@/infrastructure/database/schema";
import { closeDb } from "@/infrastructure/database/client";
import {
  getStorage,
  type LocalStorageAdapter,
  type StorageAdapter,
} from "@/infrastructure/storage";
import { AppError } from "@/lib/errors";
import { createOriginalDownload, getArtifactDetail, listArtifacts } from "@/modules/artifacts";
import {
  cancelItem,
  completeItem,
  declareItem,
  getBatchReport,
  importLimitsFromEnv,
  retryItem,
} from "@/modules/imports";
import { getEnv } from "@/infrastructure/config/env";
import {
  BIG5_SAMPLE,
  claudeDesignDocument,
  htmlDocument,
  markdownDocument,
  pdfDocument,
  pngImage,
} from "@tests/fixtures/builders";
import { closeTestDb, testDb } from "../helpers/db";
import { createTestActor, drainJobs, newBatch, uploadFile } from "../helpers/imports";

const db = testDb();
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const meta = { ipAddress: "127.0.0.1", userAgent: "vitest" };

afterAll(async () => {
  await closeDb();
  await closeTestDb();
});

async function itemById(id: string) {
  const [row] = await db.select().from(importItems).where(eq(importItems.id, id));
  return row!;
}

/** Downloads through the signed URL exactly as a browser would (local adapter route token). */
async function downloadOriginal(
  actor: Awaited<ReturnType<typeof createTestActor>>,
  artifactId: string,
  versionId: string,
) {
  const storage = getStorage() as LocalStorageAdapter;
  const signed = await createOriginalDownload(db, storage, actor, { artifactId, versionId }, meta);
  const token = new URL(signed.url).searchParams.get("token")!;
  const verified = storage.verifyDownloadToken(token);
  if (!verified.ok) throw new Error("bad token");
  const { body } = await storage.getObject(verified.claims.key);
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(chunk as Buffer);
  return { bytes: Buffer.concat(chunks), signed };
}

describe("import pipeline — single files (Phase 1A exit criteria 1, 3, 5, 6)", () => {
  it("imports an HTML file end-to-end: original, version, extraction, sections, preview", async () => {
    const actor = await createTestActor();
    const batch = await newBatch(actor);
    const html = htmlDocument();
    const queued = await uploadFile(actor, batch.id, {
      filename: "城市熱島筆記.html",
      bytes: html,
    });
    expect(queued.status).toBe("queued");

    await drainJobs();
    const item = await itemById(queued.id);
    expect(item).toMatchObject({
      status: "succeeded",
      outcome: "new_artifact",
      detectedType: "html",
      sha256: sha256(html),
    });

    const { artifact, versions } = await getArtifactDetail(db, actor, item.resultArtifactId!);
    expect(artifact.title).toBe("城市熱島研究筆記");
    expect(artifact.visibility).toBe("private");
    // The document's own description wins over a guessed first paragraph.
    expect(artifact.summary).toBe("都市熱島效應的成因與對策摘要。");
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      versionNumber: 1,
      contentKind: "html_document",
      previewKind: "static_html",
      previewStatus: "ready",
      processingStatus: "ready",
    });

    const [version] = await db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.id, item.resultVersionId!));
    expect(version?.referenceSources).toHaveLength(2);
    const [document] = await db
      .select()
      .from(extractedDocuments)
      .where(eq(extractedDocuments.id, version!.activeExtractionId!));
    expect(document).toMatchObject({
      status: "succeeded",
      language: "zh-Hant",
      extractionMethod: "html",
    });
    expect(document?.plainText).not.toContain("tracking");
    const sections = await db
      .select()
      .from(documentSections)
      .where(eq(documentSections.extractedDocumentId, document!.id));
    expect(sections.map((section) => section.heading)).toContain("自組織");

    const derived = await db
      .select()
      .from(derivedAssets)
      .where(eq(derivedAssets.artifactVersionId, version!.id));
    expect(derived).toEqual([
      expect.objectContaining({ kind: "preview_file", path: "index.html", sha256: sha256(html) }),
    ]);

    // Original download: byte-identical, hash verifiable, audited (criteria 5 & 6).
    const { bytes, signed } = await downloadOriginal(actor, artifact.id, version!.id);
    expect(sha256(bytes)).toBe(sha256(html));
    expect(signed.sha256).toBe(sha256(html));
    const audits = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "artifact.original.downloaded"),
          eq(auditLogs.targetId, version!.id),
        ),
      );
    expect(audits).toHaveLength(1);

    // Staging is cleaned up after commit.
    expect(await getStorage().headObject(item.stagingKey)).toBeNull();
  });

  it("imports PDF, Markdown, Big5 text and PNG with the right kinds", async () => {
    const actor = await createTestActor();
    const batch = await newBatch(actor);
    const files = [
      { filename: "paper.pdf", bytes: pdfDocument() },
      { filename: "momentum.md", bytes: Buffer.from(markdownDocument()) },
      { filename: "legacy-notes.txt", bytes: BIG5_SAMPLE },
      { filename: "diagram.png", bytes: await pngImage() },
    ];
    for (const file of files) await uploadFile(actor, batch.id, file);
    await drainJobs();

    const report = await getBatchReport(db, actor, batch.id);
    expect(report.batch.status).toBe("completed");
    expect(report.counts.succeeded).toBe(4);
    const byName = Object.fromEntries(report.items.map((item) => [item.originalFilename, item]));

    const pdfVersion = (await getArtifactDetail(db, actor, byName["paper.pdf"]!.resultArtifactId!))
      .versions[0]!;
    expect(pdfVersion).toMatchObject({ contentKind: "pdf", previewKind: "pdf" });
    const markdown = await getArtifactDetail(db, actor, byName["momentum.md"]!.resultArtifactId!);
    expect(markdown.artifact.title).toBe("量化交易研究摘要");
    expect(markdown.versions[0]).toMatchObject({
      contentKind: "markdown",
      sourceModel: "example-model-1",
      researchDate: "2026-09-01",
    });

    const textItem = byName["legacy-notes.txt"]!;
    expect(textItem.warnings.join()).toMatch(/TEXT_ENCODING_FALLBACK: decoded as Big5/);
    const [textDoc] = await db
      .select({ plainText: extractedDocuments.plainText })
      .from(extractedDocuments)
      .where(eq(extractedDocuments.artifactVersionId, textItem.resultVersionId!));
    expect(textDoc?.plainText).toBe("中文測試");

    const imageVersion = (
      await getArtifactDetail(db, actor, byName["diagram.png"]!.resultArtifactId!)
    ).versions[0]!;
    expect(imageVersion).toMatchObject({ contentKind: "image", previewKind: "image" });
    const thumbnails = await db
      .select()
      .from(derivedAssets)
      .where(
        and(
          eq(derivedAssets.artifactVersionId, imageVersion.id),
          eq(derivedAssets.kind, "thumbnail"),
        ),
      );
    expect(thumbnails).toHaveLength(1);
    expect(thumbnails[0]?.mimeType).toBe("image/webp");

    const listing = await listArtifacts(db, actor, { limit: 10 });
    expect(listing.items).toHaveLength(4);
    expect(listing.items.filter((card) => card.hasThumbnail)).toHaveLength(1);
  });

  it("recognises Claude Design documents without guessing a model", async () => {
    const actor = await createTestActor();
    const batch = await newBatch(actor);
    const queued = await uploadFile(actor, batch.id, {
      filename: "Urban Heat Report.dc.html",
      bytes: claudeDesignDocument(),
    });
    await drainJobs();
    const item = await itemById(queued.id);
    const { artifact, versions } = await getArtifactDetail(db, actor, item.resultArtifactId!);
    expect(artifact.title).toBe("城市沒有恆溫器，只有材料");
    expect(versions[0]).toMatchObject({
      contentKind: "claude_design_document",
      sourcePlatform: "claude_design",
      sourceModel: null,
    });
  });

  it("preserves ZIP originals honestly until archive analysis lands", async () => {
    const actor = await createTestActor();
    const batch = await newBatch(actor);
    const zipBytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]); // empty ZIP
    const queued = await uploadFile(actor, batch.id, { filename: "project.zip", bytes: zipBytes });
    await drainJobs();
    const item = await itemById(queued.id);
    expect(item.status).toBe("succeeded");
    const { versions } = await getArtifactDetail(db, actor, item.resultArtifactId!);
    expect(versions[0]).toMatchObject({
      contentKind: "archive_other",
      previewKind: "unsupported",
      previewStatus: "unavailable",
      processingStatus: "failed",
    });
    const { bytes } = await downloadOriginal(actor, item.resultArtifactId!, item.resultVersionId!);
    expect(bytes.equals(zipBytes)).toBe(true);
  });
});

describe("duplicates and versions (FR-IMP-7/8/9)", () => {
  it("same bytes → duplicate, no new version or file asset", async () => {
    const actor = await createTestActor();
    const html = htmlDocument({ title: "重複測試文件" });
    const first = await uploadFile(actor, (await newBatch(actor)).id, {
      filename: "dup-a.html",
      bytes: html,
    });
    await drainJobs();
    const second = await uploadFile(actor, (await newBatch(actor)).id, {
      filename: "renamed-copy.html",
      bytes: html,
    });
    await drainJobs();

    const a = await itemById(first.id);
    const b = await itemById(second.id);
    expect(b).toMatchObject({
      status: "duplicate",
      outcome: "duplicate_file",
      matchReason: "same_hash",
      resultArtifactId: a.resultArtifactId,
    });
    const assets = await db
      .select()
      .from(fileAssets)
      .where(eq(fileAssets.workspaceId, actor.workspaceId));
    expect(assets).toHaveLength(1);
  });

  it("same distinctive filename → new version; generic names never auto-version", async () => {
    const actor = await createTestActor();
    const v1 = await uploadFile(actor, (await newBatch(actor)).id, {
      filename: "Market Structure Study.html",
      bytes: htmlDocument({
        title: "市場結構研究 V1",
        body: "<p>第一版內容，討論市場結構與競爭。</p>",
      }),
    });
    await drainJobs();
    const v2 = await uploadFile(actor, (await newBatch(actor)).id, {
      filename: "Market Structure Study (1).html",
      bytes: htmlDocument({
        title: "市場結構研究 V2",
        body: "<p>第二版內容，加入新的企業案例與數據。</p>",
      }),
    });
    await drainJobs();
    const first = await itemById(v1.id);
    const second = await itemById(v2.id);
    expect(second).toMatchObject({
      status: "succeeded",
      outcome: "new_version",
      matchReason: "filename_stem",
      resultArtifactId: first.resultArtifactId,
    });
    const { artifact, versions } = await getArtifactDetail(db, actor, first.resultArtifactId!);
    expect(versions.map((version) => version.versionNumber)).toEqual([2, 1]);
    const card = (await listArtifacts(db, actor, { limit: 50 })).items.find(
      (item) => item.id === first.resultArtifactId,
    );
    expect(card).toMatchObject({ versionCount: 2, currentVersion: { versionNumber: 2 } });
    expect(artifact.currentVersionId).toBe(second.resultVersionId);
    // The artifact title is not silently rewritten by a new version.
    expect(artifact.title).toBe("市場結構研究 V1");

    const generic1 = await uploadFile(actor, (await newBatch(actor)).id, {
      filename: "index.html",
      bytes: htmlDocument({ title: "甲", body: "<p>內容甲甲甲甲甲甲甲甲甲甲甲。</p>" }),
    });
    const generic2 = await uploadFile(actor, (await newBatch(actor)).id, {
      filename: "index.html",
      bytes: htmlDocument({ title: "乙", body: "<p>內容乙乙乙乙乙乙乙乙乙乙乙。</p>" }),
    });
    await drainJobs();
    expect((await itemById(generic1.id)).outcome).toBe("new_artifact");
    expect((await itemById(generic2.id)).outcome).toBe("new_artifact");
  });

  it("explicit target artifact always creates a new version", async () => {
    const actor = await createTestActor();
    const first = await uploadFile(actor, (await newBatch(actor)).id, {
      filename: "alpha-topic.md",
      bytes: "# Alpha\n\nfirst",
    });
    await drainJobs();
    const target = (await itemById(first.id)).resultArtifactId!;
    const second = await uploadFile(actor, (await newBatch(actor)).id, {
      filename: "totally-different-name.md",
      bytes: "# Alpha v2\n\nsecond",
      targetArtifactId: target,
    });
    await drainJobs();
    expect(await itemById(second.id)).toMatchObject({
      outcome: "new_version",
      matchReason: "explicit_target",
      resultArtifactId: target,
    });
  });

  it("flags identical text with different bytes as a suspected duplicate without merging", async () => {
    const actor = await createTestActor();
    const body = "<p>這是一段完全相同的研究內容，只是 HTML 外殼不同。</p>";
    const a = await uploadFile(actor, (await newBatch(actor)).id, {
      filename: "copy-one-unique.html",
      bytes: `<html><body><h1>相同</h1>${body}</body></html>`,
    });
    await drainJobs();
    const b = await uploadFile(actor, (await newBatch(actor)).id, {
      filename: "copy-two-unique.html",
      bytes: `<html><head><title>相同</title></head><body>\n<h1>相同</h1>\n${body}\n</body></html>`,
    });
    await drainJobs();
    const second = await itemById(b.id);
    expect(second.outcome).toBe("new_artifact");
    expect(second.suspectedDuplicateOf).toBe((await itemById(a.id)).resultArtifactId);
    expect(second.warnings.join()).toMatch(/SUSPECTED_DUPLICATE/);
  });
});

describe("failure isolation, retry and idempotency (criteria 7 & 8)", () => {
  it("a bad file fails with a reason while the rest of the batch succeeds", async () => {
    const actor = await createTestActor();
    const batch = await newBatch(actor);
    const good = await uploadFile(actor, batch.id, {
      filename: "good-file-one.html",
      bytes: htmlDocument(),
    });
    const bad = await uploadFile(actor, batch.id, {
      filename: "fake.pdf",
      bytes: "this is not a pdf at all",
    });
    await drainJobs();
    expect((await itemById(good.id)).status).toBe("succeeded");
    expect(await itemById(bad.id)).toMatchObject({
      status: "failed",
      errorCode: "UNSUPPORTED_FILE_TYPE",
    });
    expect((await getBatchReport(db, actor, batch.id)).batch.status).toBe("completed_with_errors");
  });

  it("completing twice and re-running the job never duplicates data", async () => {
    const actor = await createTestActor();
    const batch = await newBatch(actor);
    const queued = await uploadFile(actor, batch.id, {
      filename: "idempotent-doc.html",
      bytes: htmlDocument({ title: "冪等" }),
    });
    await completeItem(db, getStorage(), actor, batch.id, queued.id);
    await drainJobs();
    // Force the job to run again (as if a lease were recovered after commit).
    await db
      .update(processingJobs)
      .set({ status: "queued", runAfter: sql`now()` })
      .where(sql`${processingJobs.payload}->>'itemId' = ${queued.id}`);
    await drainJobs();
    const versions = await db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.workspaceId, actor.workspaceId));
    const assets = await db
      .select()
      .from(fileAssets)
      .where(eq(fileAssets.workspaceId, actor.workspaceId));
    expect(versions).toHaveLength(1);
    expect(assets).toHaveLength(1);
  });

  it("a crash after storing the original but before commit recovers without duplicates", async () => {
    const actor = await createTestActor();
    const batch = await newBatch(actor);
    const queued = await uploadFile(actor, batch.id, {
      filename: "crashy-image.png",
      bytes: await pngImage(100, 80),
    });

    // Storage that fails when writing the derived thumbnail (after the original is stored).
    const real = getStorage();
    let failures = 0;
    const flaky: StorageAdapter = Object.create(real) as StorageAdapter;
    flaky.putObject = async (key, body, options) => {
      if (key.includes("/derived/") && failures === 0) {
        failures += 1;
        throw new Error("simulated storage outage");
      }
      return real.putObject(key, body, options);
    };
    await drainJobs({ storage: flaky });
    expect((await itemById(queued.id)).status).toBe("processing"); // will retry with backoff

    await db
      .update(processingJobs)
      .set({ runAfter: sql`now()` })
      .where(sql`${processingJobs.payload}->>'itemId' = ${queued.id}`);
    await drainJobs({ storage: flaky });
    expect((await itemById(queued.id)).status).toBe("succeeded");
    const assets = await db
      .select()
      .from(fileAssets)
      .where(eq(fileAssets.workspaceId, actor.workspaceId));
    const versions = await db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.workspaceId, actor.workspaceId));
    expect(assets).toHaveLength(1);
    expect(versions).toHaveLength(1);
  });

  it("retry re-queues a failed item; items whose bytes are gone are not retryable", async () => {
    const actor = await createTestActor();
    const batch = await newBatch(actor);
    const bad = await uploadFile(actor, batch.id, {
      filename: "fake2.pdf",
      bytes: "still not a pdf",
    });
    await drainJobs();
    expect((await itemById(bad.id)).status).toBe("failed");
    // Staging is kept for failed items, so retry is possible (and fails again, deterministically).
    const retried = await retryItem(db, getStorage(), actor, batch.id, bad.id);
    expect(retried.status).toBe("queued");
    await drainJobs();
    expect((await itemById(bad.id)).status).toBe("failed");

    await getStorage().deleteObject((await itemById(bad.id)).stagingKey);
    await expect(retryItem(db, getStorage(), actor, batch.id, bad.id)).rejects.toSatisfy(
      (error: unknown) => error instanceof AppError && error.code === "NOT_RETRYABLE",
    );
  });

  it("rejects size mismatches, unsupported extensions, oversize declarations and incomplete uploads", async () => {
    const actor = await createTestActor();
    const batch = await newBatch(actor);
    const limits = importLimitsFromEnv(getEnv());
    const storage = getStorage();

    await expect(
      declareItem(db, storage, actor, batch.id, { filename: "run.exe", size: 10 }, limits),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof AppError && error.code === "UNSUPPORTED_FILE_TYPE",
    );
    await expect(
      declareItem(
        db,
        storage,
        actor,
        batch.id,
        { filename: "big.pdf", size: limits.maxFileBytes + 1 },
        limits,
      ),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof AppError && error.code === "PAYLOAD_TOO_LARGE",
    );

    const { item } = await declareItem(
      db,
      storage,
      actor,
      batch.id,
      { filename: "short.txt", size: 10 },
      limits,
    );
    await expect(completeItem(db, storage, actor, batch.id, item.id)).rejects.toSatisfy(
      (error: unknown) => error instanceof AppError && error.code === "UPLOAD_INCOMPLETE",
    );
    await storage.putObject(item.stagingKey, Buffer.from("twelve bytes"));
    await expect(completeItem(db, storage, actor, batch.id, item.id)).rejects.toSatisfy(
      (error: unknown) => error instanceof AppError && error.code === "SIZE_MISMATCH",
    );
    expect(await itemById(item.id)).toMatchObject({ status: "failed", errorCode: "SIZE_MISMATCH" });
  });

  it("clientKey makes declaration idempotent; cancel removes staged bytes", async () => {
    const actor = await createTestActor();
    const batch = await newBatch(actor);
    const limits = importLimitsFromEnv(getEnv());
    const first = await declareItem(
      db,
      getStorage(),
      actor,
      batch.id,
      { filename: "k.txt", size: 3, clientKey: "file-1" },
      limits,
    );
    const again = await declareItem(
      db,
      getStorage(),
      actor,
      batch.id,
      { filename: "k.txt", size: 3, clientKey: "file-1" },
      limits,
    );
    expect(again.item.id).toBe(first.item.id);
    expect(again.created).toBe(false);
    expect(again.upload).not.toBeNull();

    await getStorage().putObject(first.item.stagingKey, Buffer.from("abc"));
    const cancelled = await cancelItem(db, getStorage(), actor, batch.id, first.item.id);
    expect(cancelled.status).toBe("cancelled");
    expect(await getStorage().headObject(first.item.stagingKey)).toBeNull();
  });
});

describe("authorization (criterion 10)", () => {
  it("other workspaces cannot see batches, artifacts or originals", async () => {
    const owner = await createTestActor();
    const stranger = await createTestActor();
    const batch = await newBatch(owner);
    const queued = await uploadFile(owner, batch.id, {
      filename: "private-research.html",
      bytes: htmlDocument({ title: "私人研究" }),
    });
    await drainJobs();
    const item = await itemById(queued.id);

    const isNotFound = (error: unknown) => error instanceof AppError && error.code === "NOT_FOUND";
    await expect(getBatchReport(db, stranger, batch.id)).rejects.toSatisfy(isNotFound);
    await expect(getArtifactDetail(db, stranger, item.resultArtifactId!)).rejects.toSatisfy(
      isNotFound,
    );
    await expect(
      createOriginalDownload(
        db,
        getStorage(),
        stranger,
        { artifactId: item.resultArtifactId!, versionId: item.resultVersionId! },
        meta,
      ),
    ).rejects.toSatisfy(isNotFound);
    await expect(retryItem(db, getStorage(), stranger, batch.id, item.id)).rejects.toSatisfy(
      isNotFound,
    );
    expect((await listArtifacts(db, stranger, { limit: 50 })).items).toHaveLength(0);
  });

  it("soft-deleted artifacts disappear from listing and download", async () => {
    const actor = await createTestActor();
    const queued = await uploadFile(actor, (await newBatch(actor)).id, {
      filename: "to-delete-doc.html",
      bytes: htmlDocument({ title: "將刪除" }),
    });
    await drainJobs();
    const item = await itemById(queued.id);
    await db
      .update(artifacts)
      .set({ deletedAt: new Date() })
      .where(eq(artifacts.id, item.resultArtifactId!));
    expect((await listArtifacts(db, actor, { limit: 50 })).items).toHaveLength(0);
    await expect(
      createOriginalDownload(
        db,
        getStorage(),
        actor,
        { artifactId: item.resultArtifactId!, versionId: item.resultVersionId! },
        meta,
      ),
    ).rejects.toThrow();
  });
});

describe("storage contents", () => {
  it("stores originals content-addressed under the workspace and never in the DB", async () => {
    const actor = await createTestActor();
    const bytes = Buffer.from(markdownDocument());
    const queued = await uploadFile(actor, (await newBatch(actor)).id, {
      filename: "content-addressed.md",
      bytes,
    });
    await drainJobs();
    const item = await itemById(queued.id);
    const [asset] = await db.select().from(fileAssets).where(eq(fileAssets.id, item.fileAssetId!));
    expect(asset?.storageKey).toBe(`ws/${actor.workspaceId}/originals/${sha256(bytes)}`);
    const { body } = await getStorage().getObject(asset!.storageKey);
    expect(await text(body)).toBe(bytes.toString());
    const links = await db
      .select()
      .from(artifactFiles)
      .where(eq(artifactFiles.fileAssetId, asset!.id));
    expect(links).toEqual([
      expect.objectContaining({ role: "original", displayName: "content-addressed.md" }),
    ]);
  });
});
