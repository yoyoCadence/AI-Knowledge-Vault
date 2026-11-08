import type { Root as MdastRoot, RootContent } from "mdast";
import { gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown } from "mdast-util-to-markdown";
import { extractText, getDocumentProxy, getMeta } from "unpdf";
import { detectLanguage } from "./language";
import { normalizeWhitespace } from "./normalize";
import type { ExtractionResult, SectionDraft } from "./types";

/** 2: page text is escaped in the Markdown, so it can never add headings (pagesMarkdown). */
export const PDF_EXTRACTOR_VERSION = 2;

/**
 * Reading mode's Markdown for the pages: a heading per page, and the page's text as text.
 *
 * It is written through mdast, so text that looks like Markdown is escaped and reads as
 * written: a line of dashes under a line (a setext heading), `#` at the start of a line, `*`
 * between numbers, a table delimiter row. So the only headings are the pages'. Reading mode
 * gives root headings the page sections' anchors in order (markdown-view `headingAnchors`), and
 * one heading more would move every later page's anchor.
 */
export function pagesMarkdown(pages: readonly { number: number; text: string }[]): string {
  const children: RootContent[] = [];
  for (const page of pages) {
    children.push({
      type: "heading",
      depth: 2,
      children: [{ type: "text", value: `第 ${page.number} 頁` }],
    });
    for (const block of page.text.split(/\n{2,}/)) {
      if (block) children.push({ type: "paragraph", children: [{ type: "text", value: block }] });
    }
  }
  const root: MdastRoot = { type: "root", children };
  return toMarkdown(root, { extensions: [gfmToMarkdown()] }).trim();
}

/**
 * PDF text per page via pdf.js (unpdf). Text extraction never runs embedded JavaScript.
 * Each page becomes a section so citations can point at "page N" (AI_RESEARCH §2).
 */
export async function extractPdf(
  bytes: Uint8Array,
  options: { filenameStem: string; maxPages: number },
): Promise<ExtractionResult> {
  // pdf.js 6 never evaluates PDF JavaScript during text extraction.
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const warnings: string[] = [];
  try {
    if (pdf.numPages > options.maxPages) {
      warnings.push(
        `PDF_PAGE_LIMIT: only the first ${options.maxPages} of ${pdf.numPages} pages were extracted`,
      );
    }
    const { text: pages } = await extractText(pdf, { mergePages: false });
    const limited = pages.slice(0, options.maxPages);

    let info: Record<string, unknown> = {};
    try {
      info = ((await getMeta(pdf)).info ?? {}) as Record<string, unknown>;
    } catch {
      warnings.push("PDF_METADATA_UNREADABLE");
    }

    const sections: SectionDraft[] = [];
    let plainText = "";
    limited.forEach((pageText, index) => {
      const text = normalizeWhitespace(pageText);
      if (!text) return;
      if (plainText) plainText += "\n\n";
      sections.push({
        ordinal: sections.length,
        level: 1,
        heading: `第 ${index + 1} 頁`,
        anchor: `page-${index + 1}`,
        charStart: plainText.length,
        charEnd: plainText.length + text.length,
      });
      plainText += text;
    });

    if (!plainText)
      warnings.push(
        "NO_TEXT_LAYER: no extractable text (possibly a scanned PDF; OCR is not supported yet)",
      );
    const metaTitle = typeof info.Title === "string" ? normalizeWhitespace(info.Title) : "";
    const firstLine = plainText.split("\n").find((line) => line.trim()) ?? "";
    const title = metaTitle || (firstLine.length <= 120 ? firstLine : "") || options.filenameStem;
    const author = typeof info.Author === "string" ? normalizeWhitespace(info.Author) : "";

    return {
      method: "pdf",
      version: PDF_EXTRACTOR_VERSION,
      status: plainText ? "succeeded" : "partial",
      title: title.slice(0, 500) || null,
      language: detectLanguage(plainText),
      plainText,
      markdown: pagesMarkdown(
        limited
          .map((pageText, index) => ({ number: index + 1, text: normalizeWhitespace(pageText) }))
          .filter((page) => page.text),
      ),
      sections,
      metadata: author ? { author: author.slice(0, 200) } : {},
      references: [],
      warnings,
    };
  } finally {
    await pdf.cleanup();
  }
}
