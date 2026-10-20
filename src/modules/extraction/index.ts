import { extractHtml } from "./html";
import { analyzeImage } from "./image";
import { extractMarkdown } from "./markdown";
import { filenameStem } from "./normalize";
import { extractPdf } from "./pdf";
import { extractPlainText } from "./plain-text";
import type { DetectedFormat } from "./sniff";
import { decodeText } from "./text-decode";
import type { Classification, ExtractionResult } from "./types";

export * from "./types";
export {
  sniffFormat,
  fileExtension,
  MIME_TYPES,
  type DetectedFormat,
  type SniffResult,
} from "./sniff";
export { contentHash, filenameStem, normalizeWhitespace, headingAnchor } from "./normalize";
export { detectLanguage } from "./language";
export { decodeText } from "./text-decode";
export { extractHtml } from "./html";
export { extractMarkdown, parseFrontMatter } from "./markdown";
export { extractPlainText } from "./plain-text";
export { extractPdf } from "./pdf";
export { analyzeImage, THUMBNAIL_GENERATOR, THUMBNAIL_GENERATOR_VERSION } from "./image";

export interface ExtractionLimits {
  /** Files above this size are preserved but not parsed (preservation never depends on parsing). */
  maxExtractBytes: number;
  pdfMaxPages: number;
  imageMaxInputPixels: number;
}

export interface SingleFileOutcome {
  extraction: ExtractionResult;
  classification: Classification;
  thumbnail?: { bytes: Buffer; mimeType: string };
}

function failedExtraction(
  method: ExtractionResult["method"],
  code: string,
  message: string,
  title: string,
): ExtractionResult {
  return {
    method,
    version: 1,
    status: "failed",
    title,
    language: null,
    plainText: "",
    markdown: "",
    sections: [],
    metadata: {},
    references: [],
    warnings: [],
    errorCode: code,
    errorMessage: message,
  };
}

const METHOD_BY_FORMAT: Partial<Record<DetectedFormat, ExtractionResult["method"]>> = {
  html: "html",
  markdown: "markdown",
  text: "text",
  pdf: "pdf",
  png: "image",
  jpeg: "image",
  webp: "image",
  gif: "image",
  zip: "archive",
};

/**
 * Extracts and classifies a single (non-archive) file. Never throws for content problems: a parse
 * failure yields `status: "failed"` with a reason, and the caller still preserves the original
 * (product principle P-1: preservation never depends on parsing).
 */
export async function extractSingleFile(input: {
  /** File contents, or null when the file is larger than `limits.maxExtractBytes`. */
  bytes: Buffer | null;
  filename: string;
  format: DetectedFormat;
  limits: ExtractionLimits;
}): Promise<SingleFileOutcome> {
  const stem = filenameStem(input.filename);
  const method = METHOD_BY_FORMAT[input.format] ?? "text";

  if (input.bytes === null || input.bytes.length > input.limits.maxExtractBytes) {
    return {
      extraction: failedExtraction(
        method,
        "TOO_LARGE_FOR_EXTRACTION",
        `file exceeds the extraction limit of ${input.limits.maxExtractBytes} bytes; original preserved`,
        stem,
      ),
      classification: classify(input.format, false),
    };
  }

  const bytes = input.bytes;
  try {
    switch (input.format) {
      case "html": {
        const decoded = decodeText(bytes);
        const { result, analysis } = extractHtml(decoded.text, {
          filename: input.filename,
          filenameStem: stem,
        });
        result.warnings.unshift(...decoded.warnings);
        const classification = classify("html", analysis.isClaudeDesign);
        classification.analysis = {
          encoding: decoded.encoding,
          externalDependencies: analysis.externalHosts,
          hasScripts: analysis.hasScripts,
          generator: analysis.generator,
        };
        return { extraction: result, classification };
      }
      case "markdown": {
        const decoded = decodeText(bytes);
        const result = extractMarkdown(decoded.text, {
          filenameStem: stem,
          warnings: decoded.warnings,
        });
        return {
          extraction: result,
          classification: {
            ...classify("markdown", false),
            analysis: { encoding: decoded.encoding },
          },
        };
      }
      case "text": {
        const decoded = decodeText(bytes);
        const result = extractPlainText(decoded.text, {
          filenameStem: stem,
          warnings: decoded.warnings,
        });
        return {
          extraction: result,
          classification: { ...classify("text", false), analysis: { encoding: decoded.encoding } },
        };
      }
      case "pdf": {
        const result = await extractPdf(bytes, {
          filenameStem: stem,
          maxPages: input.limits.pdfMaxPages,
        });
        return { extraction: result, classification: classify("pdf", false) };
      }
      case "png":
      case "jpeg":
      case "webp":
      case "gif": {
        const { info, thumbnail } = await analyzeImage(bytes, {
          maxInputPixels: input.limits.imageMaxInputPixels,
        });
        return {
          extraction: {
            ...failedExtraction("image", "", "", stem),
            status: "partial",
            errorCode: undefined,
            errorMessage: undefined,
            warnings: ["NO_TEXT_CONTENT: images are stored without OCR"],
          },
          classification: {
            ...classify(input.format, false),
            analysis: { width: info.width, height: info.height, format: info.format },
          },
          thumbnail: { bytes: thumbnail, mimeType: "image/webp" },
        };
      }
      default:
        return {
          extraction: failedExtraction(
            method,
            "UNSUPPORTED_FILE_TYPE",
            `no extractor for ${input.format}`,
            stem,
          ),
          classification: classify(input.format, false),
        };
    }
  } catch (error) {
    return {
      extraction: failedExtraction(
        method,
        "EXTRACTION_FAILED",
        error instanceof Error ? error.message.slice(0, 500) : "extraction failed",
        stem,
      ),
      classification: {
        ...classify(input.format, false),
        previewKind: "unsupported",
        previewEntryPath: null,
      },
    };
  }
}

/** Maps a detected single-file format to content/preview kinds (FR-PRV-1). */
export function classify(format: DetectedFormat, isClaudeDesign: boolean): Classification {
  switch (format) {
    case "html":
      return {
        contentKind: isClaudeDesign ? "claude_design_document" : "html_document",
        previewKind: "static_html",
        previewEntryPath: "index.html",
        analysis: {},
      };
    case "markdown":
      return {
        contentKind: "markdown",
        previewKind: "text_only",
        previewEntryPath: null,
        analysis: {},
      };
    case "text":
      return {
        contentKind: "text",
        previewKind: "text_only",
        previewEntryPath: null,
        analysis: {},
      };
    case "pdf":
      return { contentKind: "pdf", previewKind: "pdf", previewEntryPath: null, analysis: {} };
    case "png":
    case "jpeg":
    case "webp":
    case "gif":
      return { contentKind: "image", previewKind: "image", previewEntryPath: null, analysis: {} };
    case "zip":
      return {
        contentKind: "archive_other",
        previewKind: "unsupported",
        previewEntryPath: null,
        analysis: {},
      };
    default:
      return {
        contentKind: "unknown",
        previewKind: "unsupported",
        previewEntryPath: null,
        analysis: {},
      };
  }
}
