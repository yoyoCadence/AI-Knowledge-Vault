import { extractSingleFile, type ExtractionLimits } from "../single";
import { analyzeImage } from "../image";
import { mimeForPath } from "../mime";
import { filenameStem } from "../normalize";
import { sniffFormat } from "../sniff";
import type { Classification, ExtractionResult } from "../types";
import {
  classifyArchive,
  extensionOf,
  packageJsonPath,
  previewFiles,
  type ArchiveClassification,
} from "./classify";
import { SafeZip, ZipRejectedError, type ZipLimits } from "./reader";

/**
 * Archive analysis for imports (IMPORT_PIPELINE §3): validates the ZIP safely, classifies it,
 * extracts the entry document's text, picks a cover image and lists the files that form the
 * script-free preview site. Returns an open `SafeZip` so the caller can stream preview files
 * into storage; the caller must `close()` it.
 */
export const ARCHIVE_ANALYZER_VERSION = 1;

const COVER_MAX_BYTES = 20 * 1024 * 1024;
const PACKAGE_JSON_MAX_BYTES = 256 * 1024;

export interface ArchiveLimits extends ZipLimits, ExtractionLimits {
  maxPreviewFiles: number;
  maxPreviewBytes: number;
}

export interface PreviewFile {
  archivePath: string;
  sitePath: string;
  size: number;
  mimeType: string;
}

export interface ArchiveOutcome {
  extraction: ExtractionResult;
  classification: Classification;
  thumbnail?: { bytes: Buffer; mimeType: string };
  previewFiles: PreviewFile[];
  zip: SafeZip | null;
  /** Set when the archive violates a safety rule: the item fails but the original is kept. */
  rejection?: { code: string; message: string };
}

function emptyExtraction(
  title: string,
  status: ExtractionResult["status"],
  warnings: string[] = [],
): ExtractionResult {
  return {
    method: "archive",
    version: ARCHIVE_ANALYZER_VERSION,
    status,
    title,
    language: null,
    plainText: "",
    markdown: "",
    sections: [],
    metadata: {},
    references: [],
    warnings,
  };
}

async function readPackageJson(
  zip: SafeZip,
  path: string,
): Promise<Record<string, unknown> | null> {
  const size = zip.inventory.entries.find((entry) => entry.path === path)?.size;
  if (size === undefined || size > PACKAGE_JSON_MAX_BYTES) return null;
  // Integrity errors (ZipRejectedError) propagate and reject the archive; only bad JSON is ignored.
  const raw = (await zip.readBuffer(path, PACKAGE_JSON_MAX_BYTES)).toString("utf8");
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const scripts =
      parsed.scripts && typeof parsed.scripts === "object"
        ? Object.keys(parsed.scripts as object)
        : [];
    const dependencies =
      parsed.dependencies && typeof parsed.dependencies === "object"
        ? Object.keys(parsed.dependencies as object)
        : [];
    return {
      name: typeof parsed.name === "string" ? parsed.name.slice(0, 200) : null,
      description: typeof parsed.description === "string" ? parsed.description.slice(0, 500) : null,
      // Script *names* only — never their commands, and nothing is ever run (FR-PRV-5).
      scripts: scripts.slice(0, 30),
      dependencies: dependencies.slice(0, 50),
    };
  } catch {
    return null;
  }
}

function fileTreeText(classification: ArchiveClassification, paths: string[]): string {
  const listed = paths
    .slice(0, 300)
    .map((path) => `• ${path.slice(classification.rootPrefix.length)}`);
  const more = paths.length > 300 ? `\n… 另有 ${paths.length - 300} 個檔案` : "";
  return `專案檔案結構\n\n${listed.join("\n")}${more}`;
}

export async function analyzeArchive(
  filePath: string,
  filename: string,
  limits: ArchiveLimits,
): Promise<ArchiveOutcome> {
  const stem = filenameStem(filename);
  let zip: SafeZip;
  try {
    zip = await SafeZip.open(filePath, limits);
  } catch (error) {
    if (!(error instanceof ZipRejectedError)) throw error;
    return {
      extraction: {
        ...emptyExtraction(stem, "failed"),
        errorCode: "ARCHIVE_REJECTED",
        errorMessage: error.message,
      },
      classification: {
        contentKind: "archive_other",
        previewKind: "unsupported",
        previewEntryPath: null,
        analysis: { archive: { rejected: error.reason, detail: error.message } },
      },
      previewFiles: [],
      zip: null,
      rejection: {
        code: "ARCHIVE_REJECTED",
        message: `${error.message}. The original file was preserved for inspection.`,
      },
    };
  }

  try {
    const { inventory } = zip;
    const pkgPath = packageJsonPath(inventory.entries);
    const pkg = pkgPath ? await readPackageJson(zip, pkgPath) : null;
    const classification = classifyArchive(inventory.entries, {
      packageScripts: Array.isArray(pkg?.scripts) ? (pkg.scripts as string[]) : undefined,
    });
    const warnings = [...inventory.warnings];
    const analysis: Record<string, unknown> = {
      archive: {
        kind: classification.kind,
        reason: classification.reason,
        entryCount: inventory.entries.length,
        totalUncompressed: inventory.totalUncompressed,
        rootPrefix: classification.rootPrefix,
        entryPath: classification.entryPath,
        nestedArchives: inventory.nestedArchives,
        topLevel: [
          ...new Set(
            inventory.entries.map(
              (entry) => entry.path.slice(classification.rootPrefix.length).split("/")[0],
            ),
          ),
        ].slice(0, 30),
      },
    };
    if (classification.kind === "framework_source" || classification.kind === "prebuilt_site") {
      analysis.framework = pkg;
      if (classification.kind === "framework_source") {
        warnings.push(
          "BUILD_REQUIRED: source project; preview needs a build, which is never run on import",
        );
      }
    }

    // Entry document → text.
    let extraction: ExtractionResult;
    if (classification.entryPath) {
      const entryInfo = inventory.entries.find((entry) => entry.path === classification.entryPath)!;
      const basename = classification.entryPath.split("/").pop() ?? classification.entryPath;
      if (entryInfo.size > limits.maxExtractBytes) {
        extraction = {
          ...emptyExtraction(stem, "failed"),
          errorCode: "TOO_LARGE_FOR_EXTRACTION",
          errorMessage: "entry document exceeds the extraction limit",
        };
      } else {
        const bytes = await zip.readBuffer(classification.entryPath, limits.maxExtractBytes);
        const sniffed = sniffFormat(bytes.subarray(0, 4096), basename);
        const single = await extractSingleFile({
          bytes,
          filename: basename,
          format: sniffed.format,
          limits,
        });
        extraction = single.extraction;
        Object.assign(analysis, single.classification.analysis);
      }
    } else if (classification.kind === "framework_source") {
      const plainText = fileTreeText(
        classification,
        inventory.entries.map((entry) => entry.path),
      );
      extraction = {
        ...emptyExtraction(stem, "partial", ["NO_README: listing project files instead"]),
        plainText,
        markdown: plainText,
        sections: [
          {
            ordinal: 0,
            level: 0,
            heading: null,
            anchor: "preamble",
            charStart: 0,
            charEnd: plainText.length,
          },
        ],
      };
    } else {
      extraction = {
        ...emptyExtraction(stem, "failed"),
        errorCode: "NO_READABLE_DOCUMENT",
        errorMessage: classification.reason,
      };
    }
    extraction.warnings = [...warnings, ...extraction.warnings];
    if (!extraction.title) extraction.title = stem;
    if (classification.kind === "claude_design")
      extraction.metadata.sourcePlatform = "claude_design";

    // Cover image (Claude Design `.thumbnail`, or a conventionally named image).
    let thumbnail: ArchiveOutcome["thumbnail"];
    if (classification.coverPath) {
      const coverSize =
        inventory.entries.find((entry) => entry.path === classification.coverPath)?.size ?? 0;
      if (coverSize > COVER_MAX_BYTES) {
        extraction.warnings.push("COVER_TOO_LARGE: the cover image is over 20 MiB; skipped");
      } else {
        // Not caught: a ZipRejectedError here means the archive lied about the entry (size,
        // CRC) and the whole archive is rejected below, exactly as for any other entry.
        const bytes = await zip.readBuffer(classification.coverPath, COVER_MAX_BYTES);
        try {
          const format = sniffFormat(bytes.subarray(0, 64), classification.coverPath).format;
          if (["png", "jpeg", "webp", "gif"].includes(format)) {
            const { thumbnail: rendered } = await analyzeImage(bytes, {
              maxInputPixels: limits.imageMaxInputPixels,
            });
            thumbnail = { bytes: rendered, mimeType: "image/webp" };
          }
        } catch {
          extraction.warnings.push("COVER_UNREADABLE: the cover image could not be decoded");
        }
      }
    }

    // Preview site files (script-free static preview; never built or executed).
    let files: PreviewFile[] = previewFiles(inventory.entries, classification).map((file) => ({
      ...file,
      size: inventory.entries.find((entry) => entry.path === file.archivePath)!.size,
      mimeType: mimeForPath(file.sitePath),
    }));
    let previewKind = classification.previewKind;
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (files.length > limits.maxPreviewFiles || totalBytes > limits.maxPreviewBytes) {
      extraction.warnings.push(
        `PREVIEW_TOO_LARGE: ${files.length} files / ${totalBytes} bytes exceed preview limits`,
      );
      files = [];
      previewKind = "unsupported";
    }
    if (
      classification.kind === "document_bundle" &&
      extensionOf(classification.entryPath ?? "") === "pdf"
    ) {
      // Serve the PDF itself as the preview, within the same preview byte budget.
      const size = inventory.entries.find((entry) => entry.path === classification.entryPath)!.size;
      if (size > limits.maxPreviewBytes) {
        extraction.warnings.push(
          `PREVIEW_TOO_LARGE: ${size} bytes exceed the preview limit of ${limits.maxPreviewBytes}`,
        );
        previewKind = "unsupported";
      } else {
        files = [
          {
            archivePath: classification.entryPath!,
            sitePath: "document.pdf",
            size,
            mimeType: "application/pdf",
          },
        ];
      }
    }

    return {
      extraction,
      classification: {
        contentKind: classification.contentKind,
        previewKind,
        previewEntryPath:
          classification.kind === "document_bundle" && files.length === 1
            ? "document.pdf"
            : previewKind === "unsupported"
              ? null
              : classification.previewEntryPath,
        analysis,
      },
      thumbnail,
      previewFiles: files,
      zip,
    };
  } catch (error) {
    zip.close();
    if (error instanceof ZipRejectedError) {
      return {
        extraction: {
          ...emptyExtraction(stem, "failed"),
          errorCode: "ARCHIVE_REJECTED",
          errorMessage: error.message,
        },
        classification: {
          contentKind: "archive_other",
          previewKind: "unsupported",
          previewEntryPath: null,
          analysis: { archive: { rejected: error.reason } },
        },
        previewFiles: [],
        zip: null,
        rejection: {
          code: "ARCHIVE_REJECTED",
          message: `${error.message}. The original file was preserved for inspection.`,
        },
      };
    }
    throw error;
  }
}
