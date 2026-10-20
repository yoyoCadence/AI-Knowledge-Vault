import { detectLanguage } from "./language";
import { normalizeWhitespace } from "./normalize";
import type { ExtractionResult } from "./types";

export const TEXT_EXTRACTOR_VERSION = 1;

/** Plain text: one preamble section; title is the first non-empty line (capped) or the filename. */
export function extractPlainText(
  text: string,
  options: { filenameStem: string; warnings?: string[] },
): ExtractionResult {
  const plainText = normalizeWhitespace(text);
  const firstLine =
    plainText
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? "";
  const title = firstLine && firstLine.length <= 120 ? firstLine : options.filenameStem;
  const warnings = [...(options.warnings ?? [])];
  if (!plainText) warnings.push("NO_TEXT_CONTENT: file is empty");

  return {
    method: "text",
    version: TEXT_EXTRACTOR_VERSION,
    status: plainText ? "succeeded" : "partial",
    title: title || null,
    language: detectLanguage(plainText),
    plainText,
    // Escape nothing: reading mode renders this as preformatted text, never as HTML.
    markdown: plainText,
    sections: plainText
      ? [
          {
            ordinal: 0,
            level: 0,
            heading: null,
            anchor: "preamble",
            charStart: 0,
            charEnd: plainText.length,
          },
        ]
      : [],
    metadata: {},
    references: [],
    warnings,
  };
}
