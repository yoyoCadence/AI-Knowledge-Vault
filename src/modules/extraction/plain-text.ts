import { detectLanguage } from "./language";
import { normalizeWhitespace } from "./normalize";
import type { ExtractionResult } from "./types";

/** 2: reading mode shows the text as written: indentation and alignment are kept. */
export const TEXT_EXTRACTOR_VERSION = 2;

/**
 * The text as written, for reading mode, which shows it preformatted (PlainTextView). Line
 * endings are unified, trailing spaces cut, and blank lines at either end dropped. Indentation,
 * runs of spaces and blank lines inside are kept: code, a table aligned with spaces, and a
 * paragraph's full-width indent (　　) read as in the file. Search and sections use the
 * normalized plain text.
 */
function asWritten(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+$/gm, "")
    .replace(/^\n+|\n+$/g, "");
}

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
    markdown: plainText ? asWritten(text) : "",
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
