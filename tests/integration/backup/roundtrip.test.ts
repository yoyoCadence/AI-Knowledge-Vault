import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEnv } from "@/infrastructure/config/env";
import { closeDb } from "@/infrastructure/database/client";
import {
  artifactFiles,
  artifactNotes,
  artifactReadingStates,
  artifacts,
  artifactVersions,
  collectionItems,
  collections,
  derivedAssets,
  documentSections,
  extractedDocuments,
  fileAssets,
  processingJobs,
  tags,
  artifactTags,
  workspaces,
} from "@/infrastructure/database/schema";
import { getStorage, LocalStorageAdapter } from "@/infrastructure/storage";
import { AppError } from "@/lib/errors";
import {
  parseChecksums,
  PATHS,
  restoreArchive,
  restoreLimitsFromEnv,
  RESTORE_EXTRACTION_METHOD,
  writeExport,
} from "@/modules/backup";
import { formatChecksums } from "@/modules/backup/format";
import type { Actor } from "@/modules/auth";
import { createCollection, setCollectionItem } from "@/modules/collections";
import { createNote, deleteNote, setReadingState } from "@/modules/notes";
import { SEARCH_INDEX_JOB_TYPE, searchArtifacts, TOKENIZER_VERSION } from "@/modules/search";
import { ensureTag, setArtifactTag } from "@/modules/tags";
import { SafeZip } from "@/modules/extraction";
import {
  claudeDesignZipEntries,
  htmlDocument,
  markdownDocument,
  pdfDocument,
  pngImage,
} from "@tests/fixtures/builders";
import { buildZip, type ZipEntrySpec } from "@tests/fixtures/zip";
import { closeTestDb, testDb } from "../helpers/db";
import { createTestActor, drainJobs, newBatch, uploadFile } from "../helpers/imports";

/**
 * BACKUP_RECOVERY §8: an export is not a backup until a restore from it has been verified.
 * Seed through the real import pipeline → export → destroy the workspace → restore into a new
 * workspace and an empty storage root → rebuild → compare.
 */

const db = testDb();
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const meta = { ipAddress: null, userAgent: "vitest" };
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "vault-backup-test-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await closeDb();
  await closeTestDb();
});

function freshStorage(name: string) {
  return new LocalStorageAdapter(path.join(dir, name), {
    signingSecret: "r".repeat(48),
    publicBaseUrl: "http://localhost:3999",
  });
}

function exportTo(workspaceId: string, file: string) {
  return writeExport(db, getStorage(), workspaceId, createWriteStream(file));
}

async function snapshot(workspaceId: string) {
  const artifactRows = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.workspaceId, workspaceId))
    .orderBy(asc(artifacts.id));
  const versionRows = await db
    .select()
    .from(artifactVersions)
    .where(eq(artifactVersions.workspaceId, workspaceId))
    .orderBy(asc(artifactVersions.id));
  const assetRows = await db
    .select()
    .from(fileAssets)
    .where(eq(fileAssets.workspaceId, workspaceId))
    .orderBy(asc(fileAssets.sha256));
  const tagRows = await db
    .select()
    .from(tags)
    .where(eq(tags.workspaceId, workspaceId))
    .orderBy(asc(tags.id));
  const tagLinkRows = await db
    .select()
    .from(artifactTags)
    .where(eq(artifactTags.workspaceId, workspaceId))
    .orderBy(asc(artifactTags.artifactId), asc(artifactTags.tagId));
  const collectionRows = await db
    .select()
    .from(collections)
    .where(eq(collections.workspaceId, workspaceId))
    .orderBy(asc(collections.id));
  const itemRows = await db
    .select()
    .from(collectionItems)
    .where(eq(collectionItems.workspaceId, workspaceId))
    .orderBy(asc(collectionItems.collectionId), asc(collectionItems.artifactId));
  const noteRows = await db
    .select()
    .from(artifactNotes)
    .where(eq(artifactNotes.workspaceId, workspaceId))
    .orderBy(asc(artifactNotes.id));
  const stateRows = await db
    .select()
    .from(artifactReadingStates)
    .where(eq(artifactReadingStates.workspaceId, workspaceId))
    .orderBy(asc(artifactReadingStates.artifactId));
  return {
    notes: noteRows.map((row) => ({
      id: row.id,
      artifactId: row.artifactId,
      bodyMarkdown: row.bodyMarkdown,
      createdAt: row.createdAt.toISOString(),
    })),
    // Whose state it is differs between workspaces (the restoring user's), so not compared.
    readingStates: stateRows.map((row) => ({
      artifactId: row.artifactId,
      status: row.status,
      isFavorite: row.isFavorite,
      lastOpenedAt: row.lastOpenedAt?.toISOString() ?? null,
    })),
    collections: collectionRows.map((row) => ({
      id: row.id,
      parentId: row.parentId,
      kind: row.kind,
      name: row.name,
      normalizedName: row.normalizedName,
      description: row.description,
    })),
    collectionItems: itemRows.map((row) => ({
      collectionId: row.collectionId,
      artifactId: row.artifactId,
      position: row.position,
    })),
    tags: tagRows.map((row) => ({
      id: row.id,
      name: row.name,
      normalizedName: row.normalizedName,
    })),
    artifactTags: tagLinkRows.map((row) => ({ artifactId: row.artifactId, tagId: row.tagId })),
    artifacts: artifactRows.map((row) => ({
      id: row.id,
      title: row.title,
      summary: row.summary,
      visibility: row.visibility,
      identityKey: row.identityKey,
      currentVersionId: row.currentVersionId,
      createdAt: row.createdAt.toISOString(),
    })),
    versions: versionRows.map((row) => ({
      id: row.id,
      artifactId: row.artifactId,
      versionNumber: row.versionNumber,
      contentKind: row.contentKind,
      previewKind: row.previewKind,
      previewEntryPath: row.previewEntryPath,
      sourcePlatform: row.sourcePlatform,
      referenceSources: row.referenceSources,
      contentHash: row.contentHash,
    })),
    assets: assetRows.map((row) => ({
      sha256: row.sha256,
      byteSize: row.byteSize,
      mimeType: row.mimeType,
      originalFilename: row.originalFilename,
    })),
  };
}

/** Rewrites an archive with `mutate` applied to its entries (for tamper tests). */
async function rewriteArchive(
  source: string,
  target: string,
  mutate: (entries: ZipEntrySpec[]) => void,
) {
  const zip = await SafeZip.open(source, restoreLimitsFromEnv(getEnv()));
  const entries: ZipEntrySpec[] = [];
  for (const entry of zip.inventory.entries) {
    if (entry.isDirectory) continue;
    entries.push({ name: entry.path, data: await zip.readBuffer(entry.path, 64 * 1024 * 1024) });
  }
  zip.close();
  mutate(entries);
  await writeFile(target, buildZip(entries));
}

/** Recomputes checksums.sha256 and the manifest's pin, as a consistent exporter would. */
function reseal(entries: ZipEntrySpec[]) {
  const sha = (data: ZipEntrySpec["data"]) =>
    createHash("sha256")
      .update(Buffer.from(data as Buffer))
      .digest("hex");
  const listed = entries.filter(
    (entry) => entry.name !== "checksums.sha256" && entry.name !== "manifest.json",
  );
  const checksums = Buffer.from(
    formatChecksums(listed.map((entry) => ({ path: entry.name, sha256: sha(entry.data) }))),
  );
  entries.find((entry) => entry.name === "checksums.sha256")!.data = checksums;
  const manifestEntry = entries.find((entry) => entry.name === "manifest.json")!;
  const manifest = JSON.parse(Buffer.from(manifestEntry.data as Buffer).toString("utf8")) as {
    checksumsSha256: string;
  };
  manifest.checksumsSha256 = sha(checksums);
  manifestEntry.data = Buffer.from(JSON.stringify(manifest));
}

async function workspaceRowCounts(workspaceId: string) {
  const [a, v, f] = await Promise.all([
    db.select({ id: artifacts.id }).from(artifacts).where(eq(artifacts.workspaceId, workspaceId)),
    db
      .select({ id: artifactVersions.id })
      .from(artifactVersions)
      .where(eq(artifactVersions.workspaceId, workspaceId)),
    db
      .select({ id: fileAssets.id })
      .from(fileAssets)
      .where(eq(fileAssets.workspaceId, workspaceId)),
  ]);
  return { artifacts: a.length, versions: v.length, fileAssets: f.length };
}

describe("portable export → restore round trip (BACKUP_RECOVERY §8)", () => {
  let archive: string;
  let before: Awaited<ReturnType<typeof snapshot>>;
  let originals: Map<string, Buffer>;
  let target: Actor;
  let restored: LocalStorageAdapter;
  beforeAll(() => {
    restored = freshStorage("restored");
  });

  it("exports a workspace seeded through the real import pipeline", async () => {
    const source = await createTestActor();
    const batch = await newBatch(source, { options: { sourcePlatform: "chatgpt" } });
    const uploads: { filename: string; bytes: Buffer | string }[] = [
      {
        filename: "備份測試.html",
        bytes: htmlDocument({ title: `備份測試 ${source.workspaceId}` }),
      },
      {
        filename: "跨平台研究備份報告.md",
        bytes: markdownDocument() + `\n\n${source.workspaceId}\n`,
      },
      { filename: "paper.pdf", bytes: pdfDocument(["Backup PDF page", source.workspaceId]) },
      { filename: "figure.png", bytes: await pngImage(200, 120, { r: 1, g: 2, b: 250 }) },
      { filename: "Design_Export.zip", bytes: buildZip(await claudeDesignZipEntries()) },
    ];
    for (const file of uploads) await uploadFile(source, batch.id, file);
    await drainJobs();
    // A second version of the Markdown artifact (filename-based versioning).
    await uploadFile(source, batch.id, {
      filename: "跨平台研究備份報告 (1).md",
      bytes: markdownDocument() + `\n\nv2 ${source.workspaceId}\n`,
    });
    await drainJobs();

    // Tags (format v2): two on the first artifact, one shared with the second, one unused.
    const seeded = await db
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(eq(artifacts.workspaceId, source.workspaceId))
      .orderBy(asc(artifacts.createdAt), asc(artifacts.id));
    const city = (await ensureTag(db, source, "城市研究", meta)).tag;
    const model = (await ensureTag(db, source, "ＡＩ 模型", meta)).tag;
    await ensureTag(db, source, "未使用", meta);
    for (const [artifactId, tagId] of [
      [seeded[0]!.id, city.id],
      [seeded[0]!.id, model.id],
      [seeded[1]!.id, city.id],
    ] as const) {
      await setArtifactTag(db, source, { artifactId, tagId, present: true }, meta);
    }

    // Collections (format v3): a category with a subcollection, and an empty one.
    const cityCategory = await createCollection(
      db,
      source,
      { name: "城市", kind: "category", description: "城市研究" },
      meta,
    );
    const heat = await createCollection(
      db,
      source,
      { name: "熱島", parentId: cityCategory.id },
      meta,
    );
    await createCollection(db, source, { name: "待讀" }, meta);
    for (const [collectionId, artifactId] of [
      [heat.id, seeded[0]!.id],
      [cityCategory.id, seeded[2]!.id],
    ] as const) {
      await setCollectionItem(db, source, { collectionId, artifactId, present: true }, meta);
    }

    // Notes and reading state (format v4).
    await createNote(db, source, seeded[0]!.id, "第一則筆記：**熱島**觀測", meta);
    await createNote(db, source, seeded[0]!.id, "第二則筆記", meta);
    await createNote(db, source, seeded[1]!.id, "只有筆記裡有的詞：鯨豚擱淺", meta);
    await setReadingState(db, source, seeded[0]!.id, { isFavorite: true });
    await setReadingState(db, source, seeded[1]!.id, { status: "read" });
    await setReadingState(db, source, seeded[2]!.id, { opened: true });

    before = await snapshot(source.workspaceId);
    expect(before.notes).toHaveLength(3);
    expect(before.readingStates).toHaveLength(3);
    expect(before.collections).toHaveLength(3);
    expect(before.collectionItems).toHaveLength(2);
    expect(before.tags).toHaveLength(3);
    expect(before.artifactTags).toHaveLength(3);
    expect(before.artifacts).toHaveLength(5);
    expect(before.versions).toHaveLength(6);
    originals = new Map();
    for (const asset of await db
      .select()
      .from(fileAssets)
      .where(eq(fileAssets.workspaceId, source.workspaceId))) {
      originals.set(
        asset.sha256,
        await buffer((await getStorage().getObject(asset.storageKey)).body),
      );
    }

    archive = path.join(dir, "export.zip");
    const { manifest, filename } = await exportTo(source.workspaceId, archive);
    expect(filename).toMatch(/^knowledge-vault-export-.+-\d{8}T\d{6}Z\.zip$/);
    expect(manifest.formatVersion).toBe(4);
    expect(manifest.counts).toMatchObject({
      notes: 3,
      readingStates: 3,
      collections: 3,
      collectionItems: 2,
      artifacts: 5,
      artifactVersions: 6,
      fileAssets: 6,
      artifactFiles: 6,
      tags: 3,
      artifactTags: 3,
    });
    expect(manifest.counts.normalizedDocuments).toBeGreaterThanOrEqual(5);

    // The archive is verifiable without the app: unzip + `sha256sum -c`.
    const extracted = path.join(dir, "extracted");
    await mkdir(extracted);
    // Python's zipfile honours the UTF-8 name flag regardless of the locale (Info-ZIP `unzip`
    // escapes non-ASCII names unless run under a UTF-8 locale).
    execFileSync("python3", [
      "-I",
      "-c",
      "import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])",
      archive,
      extracted,
    ]);
    const check = execFileSync("sha256sum", ["--check", "--strict", PATHS.checksums], {
      cwd: extracted,
      encoding: "utf8",
    });
    expect(check).not.toMatch(/FAILED/);
    const listed = parseChecksums(await readFile(path.join(extracted, PATHS.checksums), "utf8"));
    expect(listed.size).toBeGreaterThan(10);
    // No secrets or user data beyond the documented metadata.
    const metadata = await readFile(path.join(extracted, PATHS.artifacts), "utf8");
    expect(metadata).not.toMatch(/password|session|token_hash/i);

    // Destroy the source completely (database rows; the new restore uses empty storage).
    await db.delete(workspaces).where(eq(workspaces.id, source.workspaceId));
    expect(await workspaceRowCounts(source.workspaceId)).toEqual({
      artifacts: 0,
      versions: 0,
      fileAssets: 0,
    });
  });

  it("restores into a clean workspace and empty storage with identical ids, metadata and bytes", async () => {
    const actor = await createTestActor();
    target = actor;
    const report = await restoreArchive(db, restored, {
      archivePath: archive,
      workspaceId: target.workspaceId,
      userId: target.userId,
      mode: "skip_existing",
      restoreId: actor.sessionId,
      limits: restoreLimitsFromEnv(getEnv()),
    });
    expect(report.failures).toEqual([]);
    expect(report.counts.artifacts).toMatchObject({ restored: 5, skipped: 0, copied: 0 });
    expect(report.counts.artifactVersions.restored).toBe(6);
    expect(report.counts.fileAssets).toEqual({ stored: 6, reused: 0, repaired: 0 });
    expect(report.reextractJobs).toBe(6);
    expect(report.counts.tags).toMatchObject({ restored: 3, skipped: 0, copied: 0 });
    expect(report.counts.artifactTags).toBe(3);
    expect(report.counts.collections).toEqual({ restored: 3, skipped: 0, copied: 0, failed: 0 });
    expect(report.counts.collectionItems).toBe(2);
    expect(report.counts.notes).toEqual({ restored: 3, skipped: 0, copied: 0, failed: 0 });
    expect(report.counts.readingStates).toBe(3);

    const after = await snapshot(target.workspaceId);
    expect(after.notes).toEqual(before.notes);
    expect(after.readingStates).toEqual(before.readingStates);
    expect(after.collections).toEqual(before.collections);
    expect(after.collectionItems).toEqual(before.collectionItems);
    expect(after.artifacts).toEqual(before.artifacts);
    expect(after.versions).toEqual(before.versions);
    expect(after.assets).toEqual(before.assets);
    expect(after.tags).toEqual(before.tags);
    expect(after.artifactTags).toEqual(before.artifactTags);

    // Every original is byte-identical in the new storage.
    for (const asset of await db
      .select()
      .from(fileAssets)
      .where(eq(fileAssets.workspaceId, target.workspaceId))) {
      const bytes = await buffer((await restored.getObject(asset.storageKey)).body);
      expect(sha256(bytes)).toBe(asset.sha256);
      expect(bytes.equals(originals.get(asset.sha256)!)).toBe(true);
    }

    // Archived text is readable immediately, before re-extraction runs.
    const pending = await db
      .select({ method: extractedDocuments.extractionMethod })
      .from(artifactVersions)
      .innerJoin(extractedDocuments, eq(extractedDocuments.id, artifactVersions.activeExtractionId))
      .where(eq(artifactVersions.workspaceId, target.workspaceId));
    expect(pending.length).toBeGreaterThanOrEqual(5);
    expect(new Set(pending.map((row) => row.method))).toEqual(new Set([RESTORE_EXTRACTION_METHOD]));

    // Every restored version is queued for search indexing, the image without archived text
    // too (keyed by version), so it is found by title even if its re-extraction fails.
    const indexJobs = await db
      .select({ key: processingJobs.idempotencyKey, payload: processingJobs.payload })
      .from(processingJobs)
      .where(
        and(
          eq(processingJobs.type, SEARCH_INDEX_JOB_TYPE),
          eq(processingJobs.workspaceId, target.workspaceId),
        ),
      );
    expect(new Set(indexJobs.map((job) => job.payload.versionId))).toEqual(
      new Set(after.versions.map((version) => version.id)),
    );
    const withoutText = await db
      .select({ id: artifactVersions.id })
      .from(artifactVersions)
      .where(
        and(
          eq(artifactVersions.workspaceId, target.workspaceId),
          isNull(artifactVersions.activeExtractionId),
        ),
      );
    expect(withoutText).toHaveLength(6 - pending.length);
    expect(withoutText.length).toBeGreaterThanOrEqual(1);
    for (const version of withoutText)
      expect(indexJobs.map((job) => job.key)).toContain(
        `${SEARCH_INDEX_JOB_TYPE}:version:${version.id}:${TOKENIZER_VERSION}`,
      );
  });

  it("re-extraction rebuilds text, sections, thumbnails and previews from the originals", async () => {
    await drainJobs({ storage: restored });
    // The index jobs queued by the restore include the restored tags in the metadata.
    const tagged = await searchArtifacts(db, target, { q: "城市研究" });
    expect(tagged.items).toHaveLength(2);
    const versions = await db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.workspaceId, target.workspaceId));
    expect(versions.every((version) => version.processingStatus === "ready")).toBe(true);
    const documents = await db
      .select({ method: extractedDocuments.extractionMethod, id: extractedDocuments.id })
      .from(extractedDocuments)
      .where(
        inArray(
          extractedDocuments.id,
          versions.map((version) => version.activeExtractionId!),
        ),
      );
    expect(documents.map((document) => document.method)).not.toContain(RESTORE_EXTRACTION_METHOD);
    const sections = await db
      .select({ id: documentSections.id })
      .from(documentSections)
      .where(
        inArray(
          documentSections.extractedDocumentId,
          documents.map((document) => document.id),
        ),
      );
    expect(sections.length).toBeGreaterThan(5);
    const derived = await db
      .select({ kind: derivedAssets.kind })
      .from(derivedAssets)
      .where(eq(derivedAssets.workspaceId, target.workspaceId));
    expect(derived.filter((asset) => asset.kind === "thumbnail").length).toBeGreaterThanOrEqual(2);
    expect(derived.filter((asset) => asset.kind === "preview_file").length).toBeGreaterThan(3);
    // Re-running is a no-op.
    expect(await drainJobs({ storage: restored })).toBe(0);
  });

  it("restoring again with skip_existing duplicates nothing", async () => {
    const counts = await workspaceRowCounts(target.workspaceId);
    const report = await restoreArchive(db, restored, {
      archivePath: archive,
      workspaceId: target.workspaceId,
      userId: target.userId,
      mode: "skip_existing",
      restoreId: crypto.randomUUID(),
      limits: restoreLimitsFromEnv(getEnv()),
    });
    expect(report.counts.artifacts).toMatchObject({ restored: 0, skipped: 5, copied: 0 });
    expect(report.counts.fileAssets).toEqual({ stored: 0, reused: 6, repaired: 0 });
    expect(report.counts.tags).toMatchObject({ restored: 0, skipped: 3, copied: 0 });
    expect(report.counts.artifactTags).toBe(0);
    expect(report.counts.collections).toEqual({ restored: 0, skipped: 3, copied: 0, failed: 0 });
    expect(report.counts.collectionItems).toBe(0);
    expect(report.counts.notes).toEqual({ restored: 0, skipped: 3, copied: 0, failed: 0 });
    expect(report.counts.readingStates).toBe(0);
    // Nothing differs, so nothing is reported as kept.
    expect(report.counts.artifactTagsKept).toBe(0);
    expect(report.counts.collectionItemsKept).toBe(0);
    expect(report.warnings.join("\n")).not.toMatch(/tag link|collection/);
    expect(await workspaceRowCounts(target.workspaceId)).toEqual(counts);
    const again = await snapshot(target.workspaceId);
    expect(again.tags).toEqual(before.tags);
    expect(again.artifactTags).toEqual(before.artifactTags);

    // A tag removed since the export stays removed, and the report says so.
    const removed = before.artifactTags[0]!;
    await setArtifactTag(
      db,
      target,
      { artifactId: removed.artifactId, tagId: removed.tagId, present: false },
      meta,
    );
    const rerun = await restoreArchive(db, restored, {
      archivePath: archive,
      workspaceId: target.workspaceId,
      userId: target.userId,
      mode: "skip_existing",
      restoreId: crypto.randomUUID(),
      limits: restoreLimitsFromEnv(getEnv()),
    });
    expect(rerun.counts.artifactTagsKept).toBe(1);
    expect(rerun.warnings.join("\n")).toMatch(
      /1 tag link\(s\) from the archive were not added to artifacts that already existed/,
    );
    expect((await snapshot(target.workspaceId)).artifactTags).toHaveLength(2);
    await setArtifactTag(
      db,
      target,
      { artifactId: removed.artifactId, tagId: removed.tagId, present: true },
      meta,
    );

    // Likewise an artifact taken out of a collection since the export stays out.
    const item = before.collectionItems[0]!;
    await setCollectionItem(
      db,
      target,
      { collectionId: item.collectionId, artifactId: item.artifactId, present: false },
      meta,
    );
    const third = await restoreArchive(db, restored, {
      archivePath: archive,
      workspaceId: target.workspaceId,
      userId: target.userId,
      mode: "skip_existing",
      restoreId: crypto.randomUUID(),
      limits: restoreLimitsFromEnv(getEnv()),
    });
    expect(third.counts.collectionItemsKept).toBe(1);
    expect(third.warnings.join("\n")).toMatch(
      /1 collection item\(s\) from the archive were not added to artifacts that already existed/,
    );
    expect((await snapshot(target.workspaceId)).collectionItems).toHaveLength(1);
    await setCollectionItem(
      db,
      target,
      { collectionId: item.collectionId, artifactId: item.artifactId, present: true },
      meta,
    );

    // A note lost since the export comes back (like a version), and search finds it again.
    const lost = before.notes.find((note) => note.bodyMarkdown.includes("鯨豚擱淺"))!;
    await deleteNote(db, target, lost.id, meta);
    expect((await searchArtifacts(db, target, { q: "鯨豚擱淺" })).items).toEqual([]);
    const fourth = await restoreArchive(db, restored, {
      archivePath: archive,
      workspaceId: target.workspaceId,
      userId: target.userId,
      mode: "skip_existing",
      restoreId: crypto.randomUUID(),
      limits: restoreLimitsFromEnv(getEnv()),
    });
    expect(fourth.counts.notes).toEqual({ restored: 1, skipped: 2, copied: 0, failed: 0 });
    expect((await snapshot(target.workspaceId)).notes).toEqual(before.notes);
    expect(
      (await searchArtifacts(db, target, { q: "鯨豚擱淺" })).items.map((hit) => hit.id),
    ).toEqual([lost.artifactId]);
  });

  it("copy mode creates new ids for the same content and reuses the stored originals", async () => {
    const counts = await workspaceRowCounts(target.workspaceId);
    const restoreId = crypto.randomUUID();
    const report = await restoreArchive(db, restored, {
      archivePath: archive,
      workspaceId: target.workspaceId,
      userId: target.userId,
      mode: "copy",
      restoreId,
      limits: restoreLimitsFromEnv(getEnv()),
    });
    expect(report.counts.artifacts).toMatchObject({ restored: 0, skipped: 0, copied: 5 });
    expect(report.counts.fileAssets).toEqual({ stored: 0, reused: 6, repaired: 0 });
    // Tags are merged by name: the copies carry the existing tags, none is duplicated.
    expect(report.counts.tags).toMatchObject({ restored: 0, skipped: 3, copied: 0 });
    expect(report.counts.artifactTags).toBe(3);
    // Collections too are merged by place and name; the copies join them.
    expect(report.counts.collections).toEqual({ restored: 0, skipped: 3, copied: 0, failed: 0 });
    expect(report.counts.collectionItems).toBe(2);
    const afterCopy = await snapshot(target.workspaceId);
    expect(afterCopy.tags).toEqual(before.tags);
    expect(afterCopy.artifactTags).toHaveLength(6);
    expect(afterCopy.collections).toEqual(before.collections);
    expect(afterCopy.collectionItems).toHaveLength(4);
    expect(report.counts.notes).toEqual({ restored: 0, skipped: 0, copied: 3, failed: 0 });
    expect(report.counts.readingStates).toBe(3);
    expect(afterCopy.notes).toHaveLength(6);
    const now = await workspaceRowCounts(target.workspaceId);
    expect(now).toEqual({
      artifacts: counts.artifacts + 5,
      versions: counts.versions + 6,
      fileAssets: counts.fileAssets,
    });
    const copies = await db
      .select()
      .from(artifacts)
      .where(
        and(
          eq(artifacts.workspaceId, target.workspaceId),
          eq(artifacts.originRef, `restore:${restoreId}:${before.artifacts[0]!.id}`),
        ),
      );
    expect(copies).toHaveLength(1);
    expect(copies[0]!.title.endsWith("（還原副本）")).toBe(true);
    expect(copies[0]!.id).not.toBe(before.artifacts[0]!.id);
    const links = await db
      .select({ id: artifactFiles.id })
      .from(artifactFiles)
      .innerJoin(artifactVersions, eq(artifactVersions.id, artifactFiles.artifactVersionId))
      .where(eq(artifactVersions.artifactId, copies[0]!.id));
    expect(links.length).toBeGreaterThanOrEqual(1);
  });

  it("a retried copy-mode attempt resumes the same run instead of copying again", async () => {
    const restoreId = crypto.randomUUID();
    const copy = () =>
      restoreArchive(db, restored, {
        archivePath: archive,
        workspaceId: target.workspaceId,
        userId: target.userId,
        mode: "copy",
        restoreId,
        limits: restoreLimitsFromEnv(getEnv()),
      });
    const first = await copy();
    const counts = await workspaceRowCounts(target.workspaceId);
    // e.g. the job failed after the last insert and the queue retried it.
    const retry = await copy();
    expect(await workspaceRowCounts(target.workspaceId)).toEqual(counts);
    expect(retry.counts.artifacts).toEqual(first.counts.artifacts);
    expect(retry.counts.artifactVersions).toEqual(first.counts.artifactVersions);
    expect(retry.counts.researchProjects).toEqual(first.counts.researchProjects);
    expect(retry.counts.collections).toEqual(first.counts.collections);
    expect(retry.counts.collectionItems).toEqual(first.counts.collectionItems);
    expect(retry.counts.notes).toEqual(first.counts.notes);
    expect(retry.idMap).toEqual(first.idMap);
  });

  it("an archive whose metadata repeats a primary id is refused before anything is written", async () => {
    const duplicated = path.join(dir, "duplicate-ids.zip");
    await rewriteArchive(archive, duplicated, (entries) => {
      const assetsEntry = entries.find((entry) => entry.name === "metadata/file_assets.json")!;
      const assets = JSON.parse(Buffer.from(assetsEntry.data as Buffer).toString("utf8")) as {
        id: string;
      }[];
      // A second, different original under the first one's id; everything else is consistent.
      assets.push({ ...assets[1]!, id: assets[0]!.id });
      assetsEntry.data = Buffer.from(JSON.stringify(assets));
      reseal(entries);
    });
    const fresh = await createTestActor();
    const empty = freshStorage("duplicate-ids");
    await expect(
      restoreArchive(db, empty, {
        archivePath: duplicated,
        workspaceId: fresh.workspaceId,
        userId: fresh.userId,
        mode: "skip_existing",
        restoreId: crypto.randomUUID(),
        limits: restoreLimitsFromEnv(getEnv()),
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AppError &&
        error.code === "UNSUPPORTED_EXPORT_FORMAT" &&
        error.details?.nothingWritten === true &&
        /file asset [0-9a-f-]+: duplicate id/.test(JSON.stringify(error.details.problems)),
    );
    expect(await workspaceRowCounts(fresh.workspaceId)).toEqual({
      artifacts: 0,
      versions: 0,
      fileAssets: 0,
    });
  });

  it("a tampered original aborts the restore with CHECKSUM_MISMATCH before anything is written", async () => {
    const tampered = path.join(dir, "tampered.zip");
    await rewriteArchive(archive, tampered, (entries) => {
      const original = entries.find((entry) => entry.name.startsWith("originals/"))!;
      const bytes = Buffer.from(original.data as Buffer);
      bytes.writeUInt8(bytes.readUInt8(bytes.length - 1) ^ 0xff, bytes.length - 1);
      original.data = bytes;
    });
    const fresh = await createTestActor();
    const empty = freshStorage("tamper");
    await expect(
      restoreArchive(db, empty, {
        archivePath: tampered,
        workspaceId: fresh.workspaceId,
        userId: fresh.userId,
        mode: "skip_existing",
        restoreId: crypto.randomUUID(),
        limits: restoreLimitsFromEnv(getEnv()),
      }),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof AppError && error.code === "CHECKSUM_MISMATCH",
    );
    expect(await workspaceRowCounts(fresh.workspaceId)).toEqual({
      artifacts: 0,
      versions: 0,
      fileAssets: 0,
    });
    expect((await empty.listObjects("ws/")).items).toHaveLength(0);
  });

  it("a forged checksums file is caught by the manifest's pinned hash", async () => {
    const forged = path.join(dir, "forged.zip");
    await rewriteArchive(archive, forged, (entries) => {
      const original = entries.find((entry) => entry.name.startsWith("originals/"))!;
      const bytes = Buffer.from(original.data as Buffer);
      bytes.writeUInt8(bytes.readUInt8(0) ^ 0xff, 0);
      original.data = bytes;
      const checksums = entries.find((entry) => entry.name === PATHS.checksums)!;
      checksums.data = (checksums.data as Buffer)
        .toString("utf8")
        .split("\n")
        .map((line) => (line.endsWith(original.name) ? `${sha256(bytes)}  ${original.name}` : line))
        .join("\n");
    });
    const fresh = await createTestActor();
    await expect(
      restoreArchive(db, freshStorage("forged"), {
        archivePath: forged,
        workspaceId: fresh.workspaceId,
        userId: fresh.userId,
        mode: "skip_existing",
        restoreId: crypto.randomUUID(),
        limits: restoreLimitsFromEnv(getEnv()),
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AppError &&
        error.code === "CHECKSUM_MISMATCH" &&
        /manifest/.test(error.message),
    );
  });

  it("reads all export metadata from one repeatable-read snapshot", async () => {
    // Postgres gives one snapshot to every statement of a REPEATABLE READ transaction, so an
    // import committing mid-export cannot produce a version whose artifact is missing.
    const actor = await createTestActor();
    const configs: unknown[] = [];
    const spy = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "transaction") {
          return (fn: Parameters<typeof db.transaction>[0], config?: unknown) => {
            configs.push(config);
            return target.transaction(fn, config as Parameters<typeof db.transaction>[1]);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    await writeExport(
      spy,
      getStorage(),
      actor.workspaceId,
      createWriteStream(path.join(dir, "snap.zip")),
    );
    expect(configs).toEqual([{ isolationLevel: "repeatable read", accessMode: "read only" }]);
  });

  it("still restores a format v3 archive (no notes or reading states)", async () => {
    const v3 = path.join(dir, "format-v3.zip");
    await rewriteArchive(archive, v3, (entries) => {
      for (const name of [PATHS.notes, PATHS.readingStates]) {
        entries.splice(
          entries.findIndex((entry) => entry.name === name),
          1,
        );
      }
      for (const name of [PATHS.manifest, PATHS.schemaVersion]) {
        const entry = entries.find((candidate) => candidate.name === name)!;
        const json = JSON.parse(Buffer.from(entry.data as Buffer).toString("utf8")) as {
          formatVersion: number;
          counts?: Record<string, number>;
        };
        json.formatVersion = 3;
        delete json.counts?.notes;
        delete json.counts?.readingStates;
        entry.data = Buffer.from(JSON.stringify(json));
      }
      reseal(entries);
    });
    const fresh = await createTestActor();
    const report = await restoreArchive(db, freshStorage("format-v3"), {
      archivePath: v3,
      workspaceId: fresh.workspaceId,
      userId: fresh.userId,
      mode: "copy",
      restoreId: crypto.randomUUID(),
      limits: restoreLimitsFromEnv(getEnv()),
    });
    expect(report.source.formatVersion).toBe(3);
    expect(report.failures).toEqual([]);
    expect(report.counts.artifacts.copied).toBe(5);
    expect(report.counts.collections.copied).toBe(3);
    expect(report.counts.notes).toEqual({ restored: 0, skipped: 0, copied: 0, failed: 0 });
    const restoredHere = await snapshot(fresh.workspaceId);
    expect(restoredHere.notes).toEqual([]);
    expect(restoredHere.readingStates).toEqual([]);
  });

  it("refuses inconsistent note and reading-state metadata before anything is written", async () => {
    type Json = Record<string, unknown>[];
    const cases: [string, string, (rows: Json) => void][] = [
      ["note without artifact", PATHS.notes, (rows) => (rows[0]!.artifactId = crypto.randomUUID())],
      ["spoofed note", PATHS.notes, (rows) => (rows[0]!.bodyMarkdown = "abc\u202eexe")],
      ["blank note", PATHS.notes, (rows) => (rows[0]!.bodyMarkdown = "   ")],
      ["duplicate note", PATHS.notes, (rows) => rows.push({ ...rows[0]! })],
      [
        "state without artifact",
        PATHS.readingStates,
        (rows) => (rows[0]!.artifactId = crypto.randomUUID()),
      ],
      ["duplicate state", PATHS.readingStates, (rows) => rows.push({ ...rows[0]! })],
      ["unknown status", PATHS.readingStates, (rows) => (rows[0]!.status = "skimmed")],
    ];
    for (const [label, entryPath, mutate] of cases) {
      const broken = path.join(dir, `notes-${label.replaceAll(" ", "-")}.zip`);
      await rewriteArchive(archive, broken, (entries) => {
        const entry = entries.find((candidate) => candidate.name === entryPath)!;
        const rows = JSON.parse(Buffer.from(entry.data as Buffer).toString("utf8")) as Json;
        mutate(rows);
        entry.data = Buffer.from(JSON.stringify(rows));
        reseal(entries);
      });
      const fresh = await createTestActor();
      await expect(
        restoreArchive(db, freshStorage(`notes-${label}`), {
          archivePath: broken,
          workspaceId: fresh.workspaceId,
          userId: fresh.userId,
          mode: "skip_existing",
          restoreId: crypto.randomUUID(),
          limits: restoreLimitsFromEnv(getEnv()),
        }),
        label,
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof AppError &&
          error.code === "UNSUPPORTED_EXPORT_FORMAT" &&
          error.details?.nothingWritten === true,
      );
      expect(await workspaceRowCounts(fresh.workspaceId), label).toEqual({
        artifacts: 0,
        versions: 0,
        fileAssets: 0,
      });
    }
  });

  it("still restores a format v2 archive (no collections)", async () => {
    const v2 = path.join(dir, "format-v2.zip");
    await rewriteArchive(archive, v2, (entries) => {
      for (const name of [
        PATHS.collections,
        PATHS.collectionItems,
        PATHS.notes,
        PATHS.readingStates,
      ]) {
        entries.splice(
          entries.findIndex((entry) => entry.name === name),
          1,
        );
      }
      for (const name of [PATHS.manifest, PATHS.schemaVersion]) {
        const entry = entries.find((candidate) => candidate.name === name)!;
        const json = JSON.parse(Buffer.from(entry.data as Buffer).toString("utf8")) as {
          formatVersion: number;
          counts?: Record<string, number>;
        };
        json.formatVersion = 2;
        for (const key of ["collections", "collectionItems", "notes", "readingStates"])
          delete json.counts?.[key];
        entry.data = Buffer.from(JSON.stringify(json));
      }
      reseal(entries);
    });
    const fresh = await createTestActor();
    const report = await restoreArchive(db, freshStorage("format-v2"), {
      archivePath: v2,
      workspaceId: fresh.workspaceId,
      userId: fresh.userId,
      mode: "copy",
      restoreId: crypto.randomUUID(),
      limits: restoreLimitsFromEnv(getEnv()),
    });
    expect(report.source.formatVersion).toBe(2);
    expect(report.failures).toEqual([]);
    expect(report.counts.artifacts.copied).toBe(5);
    expect(report.counts.tags.copied).toBe(3);
    expect(report.counts.collections).toEqual({ restored: 0, skipped: 0, copied: 0, failed: 0 });
    expect((await snapshot(fresh.workspaceId)).collections).toEqual([]);
  });

  it("still restores a format v1 archive (no tags)", async () => {
    const v1 = path.join(dir, "format-v1.zip");
    await rewriteArchive(archive, v1, (entries) => {
      for (const name of [
        PATHS.tags,
        PATHS.artifactTags,
        PATHS.collections,
        PATHS.collectionItems,
        PATHS.notes,
        PATHS.readingStates,
      ]) {
        entries.splice(
          entries.findIndex((entry) => entry.name === name),
          1,
        );
      }
      for (const name of [PATHS.manifest, PATHS.schemaVersion]) {
        const entry = entries.find((candidate) => candidate.name === name)!;
        const json = JSON.parse(Buffer.from(entry.data as Buffer).toString("utf8")) as {
          formatVersion: number;
          counts?: Record<string, number>;
        };
        json.formatVersion = 1;
        for (const key of [
          "tags",
          "artifactTags",
          "collections",
          "collectionItems",
          "notes",
          "readingStates",
        ])
          delete json.counts?.[key];
        entry.data = Buffer.from(JSON.stringify(json));
      }
      reseal(entries);
    });
    const fresh = await createTestActor();
    const report = await restoreArchive(db, freshStorage("format-v1"), {
      archivePath: v1,
      workspaceId: fresh.workspaceId,
      userId: fresh.userId,
      mode: "copy",
      restoreId: crypto.randomUUID(),
      limits: restoreLimitsFromEnv(getEnv()),
    });
    expect(report.source.formatVersion).toBe(1);
    expect(report.failures).toEqual([]);
    expect(report.counts.artifacts.copied).toBe(5);
    expect(report.counts.tags).toMatchObject({ restored: 0, skipped: 0, copied: 0 });
    expect((await snapshot(fresh.workspaceId)).tags).toEqual([]);
  });

  it("refuses inconsistent tag metadata before anything is written", async () => {
    const cases: [string, (tagList: { id: string; name: string }[], links: unknown[]) => void][] = [
      [
        "dangling",
        (_tags, links) => links.push({ ...(links[0] as object), tagId: crypto.randomUUID() }),
      ],
      ["same name", (tagList) => (tagList[1]!.name = ` ${tagList[0]!.name.toUpperCase()} `)],
    ];
    for (const [label, mutate] of cases) {
      const broken = path.join(dir, `tags-${label.replace(" ", "-")}.zip`);
      await rewriteArchive(archive, broken, (entries) => {
        const tagEntry = entries.find((entry) => entry.name === PATHS.tags)!;
        const linkEntry = entries.find((entry) => entry.name === PATHS.artifactTags)!;
        const tagList = JSON.parse(Buffer.from(tagEntry.data as Buffer).toString("utf8")) as {
          id: string;
          name: string;
        }[];
        const links = JSON.parse(
          Buffer.from(linkEntry.data as Buffer).toString("utf8"),
        ) as unknown[];
        mutate(tagList, links);
        tagEntry.data = Buffer.from(JSON.stringify(tagList));
        linkEntry.data = Buffer.from(JSON.stringify(links));
        reseal(entries);
      });
      const fresh = await createTestActor();
      await expect(
        restoreArchive(db, freshStorage(`tags-${label}`), {
          archivePath: broken,
          workspaceId: fresh.workspaceId,
          userId: fresh.userId,
          mode: "skip_existing",
          restoreId: crypto.randomUUID(),
          limits: restoreLimitsFromEnv(getEnv()),
        }),
        label,
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof AppError &&
          error.code === "UNSUPPORTED_EXPORT_FORMAT" &&
          error.details?.nothingWritten === true,
      );
      expect(await workspaceRowCounts(fresh.workspaceId), label).toEqual({
        artifacts: 0,
        versions: 0,
        fileAssets: 0,
      });
    }
  });

  it("refuses inconsistent collection metadata before anything is written", async () => {
    type Row = {
      id: string;
      parentId: string | null;
      name: string;
      description: string | null;
      sortOrder: number;
      createdAt: string;
    };
    type Item = { collectionId: string; artifactId: string; position: number };
    const cases: [string, (rows: Row[], items: Item[]) => void][] = [
      ["unknown parent", (rows) => (rows[0]!.parentId = crypto.randomUUID())],
      [
        "cycle",
        (rows) => {
          const child = rows.find((row) => row.parentId !== null)!;
          rows.find((row) => row.id === child.parentId)!.parentId = child.id;
        },
      ],
      [
        "too deep",
        (rows) => {
          let parentId: string | null = null;
          for (let level = 0; level < 8; level += 1) {
            const id = crypto.randomUUID();
            rows.push({ ...rows[0]!, id, parentId, name: `層 ${level}` });
            parentId = id;
          }
        },
      ],
      [
        "sibling name",
        (rows) => {
          const top = rows.filter((row) => row.parentId === null);
          top[1]!.name = ` ${top[0]!.name} `;
        },
      ],
      ["invalid name", (rows) => (rows[0]!.name = "\u202e")],
      [
        "dangling item",
        (_rows, items) => items.push({ ...items[0]!, artifactId: crypto.randomUUID() }),
      ],
      ["duplicate item", (_rows, items) => items.push({ ...items[0]! })],
      // Values Postgres or the app would refuse, which must not fail the restore half-way.
      ["sort order", (rows) => (rows[0]!.sortOrder = 2 ** 31)],
      ["position", (_rows, items) => (items[0]!.position = 2 ** 31)],
      ["spoofed description", (rows) => (rows[0]!.description = "abc\u202eexe")],
      ["long description", (rows) => (rows[0]!.description = "長".repeat(2_001))],
      ["year 0", (rows) => (rows[0]!.createdAt = "0000-01-01T00:00:00.000Z")],
    ];
    for (const [label, mutate] of cases) {
      const broken = path.join(dir, `collections-${label.replace(" ", "-")}.zip`);
      await rewriteArchive(archive, broken, (entries) => {
        const rowEntry = entries.find((entry) => entry.name === PATHS.collections)!;
        const itemEntry = entries.find((entry) => entry.name === PATHS.collectionItems)!;
        const rows = JSON.parse(Buffer.from(rowEntry.data as Buffer).toString("utf8")) as Row[];
        const items = JSON.parse(Buffer.from(itemEntry.data as Buffer).toString("utf8")) as Item[];
        mutate(rows, items);
        rowEntry.data = Buffer.from(JSON.stringify(rows));
        itemEntry.data = Buffer.from(JSON.stringify(items));
        reseal(entries);
      });
      const fresh = await createTestActor();
      await expect(
        restoreArchive(db, freshStorage(`collections-${label}`), {
          archivePath: broken,
          workspaceId: fresh.workspaceId,
          userId: fresh.userId,
          mode: "skip_existing",
          restoreId: crypto.randomUUID(),
          limits: restoreLimitsFromEnv(getEnv()),
        }),
        label,
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof AppError &&
          error.code === "UNSUPPORTED_EXPORT_FORMAT" &&
          error.details?.nothingWritten === true &&
          /collection/.test(error.message + JSON.stringify(error.details)),
      );
      expect((await snapshot(fresh.workspaceId)).collections, label).toEqual([]);
      expect(await workspaceRowCounts(fresh.workspaceId), label).toEqual({
        artifacts: 0,
        versions: 0,
        fileAssets: 0,
      });
    }
  });

  it("refuses text and dates Postgres cannot store before anything is written", async () => {
    type Json = Record<string, unknown>[];
    const cases: [string, string, (rows: Json) => void][] = [
      ["NUL in a title", PATHS.artifacts, (rows) => (rows[0]!.title = "a\u0000b")],
      [
        "NUL in a nested key",
        PATHS.versions,
        (rows) => (rows[0]!.analysis = { deep: [{ ["k\u0000"]: 1 }] }),
      ],
      ["year 0 research date", PATHS.versions, (rows) => (rows[0]!.researchDate = "0000-01-01")],
      ["year 0 timestamp", PATHS.tags, (rows) => (rows[0]!.createdAt = "0000-06-01T00:00:00Z")],
    ];
    for (const [label, entryPath, mutate] of cases) {
      const broken = path.join(dir, `unstorable-${label.replaceAll(" ", "-")}.zip`);
      await rewriteArchive(archive, broken, (entries) => {
        const entry = entries.find((candidate) => candidate.name === entryPath)!;
        const rows = JSON.parse(Buffer.from(entry.data as Buffer).toString("utf8")) as Json;
        mutate(rows);
        entry.data = Buffer.from(JSON.stringify(rows));
        reseal(entries);
      });
      const fresh = await createTestActor();
      await expect(
        restoreArchive(db, freshStorage(`unstorable-${label}`), {
          archivePath: broken,
          workspaceId: fresh.workspaceId,
          userId: fresh.userId,
          mode: "skip_existing",
          restoreId: crypto.randomUUID(),
          limits: restoreLimitsFromEnv(getEnv()),
        }),
        label,
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof AppError &&
          error.code === "UNSUPPORTED_EXPORT_FORMAT" &&
          error.details?.nothingWritten === true,
      );
      expect(await workspaceRowCounts(fresh.workspaceId), label).toEqual({
        artifacts: 0,
        versions: 0,
        fileAssets: 0,
      });
    }
  });

  it("rejects archives that are not supported exports", async () => {
    const future = path.join(dir, "format-v99.zip");
    await rewriteArchive(archive, future, (entries) => {
      const entry = entries.find((candidate) => candidate.name === PATHS.manifest)!;
      const json = JSON.parse(Buffer.from(entry.data as Buffer).toString("utf8")) as {
        formatVersion: number;
      };
      json.formatVersion = 99;
      entry.data = Buffer.from(JSON.stringify(json));
      reseal(entries);
    });
    const someone = await createTestActor();
    await expect(
      restoreArchive(db, freshStorage("future"), {
        archivePath: future,
        workspaceId: someone.workspaceId,
        userId: someone.userId,
        mode: "skip_existing",
        restoreId: crypto.randomUUID(),
        limits: restoreLimitsFromEnv(getEnv()),
      }),
    ).rejects.toThrow(/unsupported export format .* v99/);

    const bogus = path.join(dir, "bogus.zip");
    await writeFile(bogus, buildZip([{ name: "index.html", data: htmlDocument() }]));
    const fresh = await createTestActor();
    await expect(
      restoreArchive(db, freshStorage("bogus"), {
        archivePath: bogus,
        workspaceId: fresh.workspaceId,
        userId: fresh.userId,
        mode: "skip_existing",
        restoreId: crypto.randomUUID(),
        limits: restoreLimitsFromEnv(getEnv()),
      }),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof AppError && error.code === "UNSUPPORTED_EXPORT_FORMAT",
    );
  });
});
