import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEnv } from "@/infrastructure/config/env";
import { closeDb } from "@/infrastructure/database/client";
import {
  artifactFiles,
  artifacts,
  artifactVersions,
  derivedAssets,
  documentSections,
  extractedDocuments,
  fileAssets,
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
  return {
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
  let target: { workspaceId: string; userId: string };
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

    before = await snapshot(source.workspaceId);
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
    expect(manifest.counts).toMatchObject({
      artifacts: 5,
      artifactVersions: 6,
      fileAssets: 6,
      artifactFiles: 6,
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
    target = { workspaceId: actor.workspaceId, userId: actor.userId };
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

    const after = await snapshot(target.workspaceId);
    expect(after.artifacts).toEqual(before.artifacts);
    expect(after.versions).toEqual(before.versions);
    expect(after.assets).toEqual(before.assets);

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
  });

  it("re-extraction rebuilds text, sections, thumbnails and previews from the originals", async () => {
    await drainJobs({ storage: restored });
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
    expect(await workspaceRowCounts(target.workspaceId)).toEqual(counts);
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

  it("rejects archives that are not format v1 exports", async () => {
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
