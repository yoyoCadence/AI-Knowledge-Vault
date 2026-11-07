import type { Nodes as MdastNodes, Root as MdastRoot, RootContent } from "mdast";
import { gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown } from "mdast-util-to-markdown";
import type { ReferenceSource } from "@/infrastructure/database/schema";
import { headingAnchor, normalizeWhitespace } from "./normalize";
import type { SectionDraft } from "./types";

/**
 * Turns an mdast tree into the normalized representations stored in extracted_documents:
 * Markdown (for reading mode), plain text (for search/AI), sections with exact character offsets
 * into the plain text (for TOC and citations), and the document's own reference list.
 */
export interface DocumentParts {
  markdown: string;
  plainText: string;
  sections: SectionDraft[];
  references: ReferenceSource[];
  firstHeading: string | null;
}

const REFERENCE_HEADING =
  /^(sources?|references?|bibliography|citations?|來源|参考|參考(資料|文獻|来源|來源)?|引用(資料|文獻)?|資料來源|文獻)$/i;
const MAX_REFERENCES = 200;

/** Raw `<br>` in Markdown is a line break, like a hard break. */
const HTML_BREAK = /^<br\s*\/?>$/i;

/**
 * A node's text, as mdast-util-to-string reads it, but with words kept apart:
 *
 * - a hard break (`<br>`, or two trailing spaces or a backslash in Markdown) is a line break;
 * - raw HTML in Markdown is markup, not text: `<kbd>Ctrl</kbd>` is "Ctrl" (the text between
 *   two tags is a node of its own);
 * - an image's alt text stands apart from its neighbours, as the image does on the page.
 */
function inlineText(node: MdastNodes): string {
  switch (node.type) {
    case "break":
      return "\n";
    case "html":
      return HTML_BREAK.test(node.value.trim()) ? "\n" : "";
    case "image":
    case "imageReference":
      return node.alt ? ` ${node.alt} ` : "";
    default:
      if ("value" in node) return node.value;
      if ("children" in node)
        return node.children.map((child) => inlineText(child as MdastNodes)).join("");
      return "";
  }
}

/** A node's text on one line: a heading, a table cell, a link's title. */
const lineText = (node: MdastNodes) => normalizeWhitespace(inlineText(node).replace(/\n+/g, " "));

function blockText(node: MdastNodes): string {
  switch (node.type) {
    case "code":
      return node.value;
    case "html":
      return "";
    case "image":
      return node.alt ?? "";
    case "thematicBreak":
      return "";
    case "list":
      return node.children.map((item) => `• ${blockText(item).replace(/\n/g, "\n  ")}`).join("\n");
    case "listItem":
    case "blockquote":
      return node.children
        .map((child) => blockText(child))
        .filter(Boolean)
        .join("\n");
    case "table":
      return (
        node.children
          .map((row) => row.children.map((cell) => lineText(cell)))
          // A table with no header row gets an empty one in Markdown: it is no text.
          .filter((cells) => cells.some(Boolean))
          .map((cells) => cells.join(" | "))
          .join("\n")
      );
    default:
      return normalizeWhitespace(inlineText(node));
  }
}

function collectLinks(node: MdastNodes, out: ReferenceSource[]): void {
  if (out.length >= MAX_REFERENCES) return;
  if (node.type === "link" && /^https?:\/\//i.test(node.url)) {
    const title = lineText(node);
    out.push(title && title !== node.url ? { title, url: node.url } : { url: node.url });
    return;
  }
  if ("children" in node) for (const child of node.children) collectLinks(child as MdastNodes, out);
}

export function buildDocument(root: MdastRoot): DocumentParts {
  const blocks: { text: string; heading?: { depth: number; text: string } }[] = [];
  const references: ReferenceSource[] = [];
  let referenceDepth: number | null = null;

  for (const child of root.children as RootContent[]) {
    if (child.type === "heading") {
      const text = lineText(child);
      if (referenceDepth !== null && child.depth <= referenceDepth) referenceDepth = null;
      if (REFERENCE_HEADING.test(text.replace(/[:：\s]+$/, ""))) referenceDepth = child.depth;
      blocks.push({ text, heading: { depth: child.depth, text } });
      continue;
    }
    if (referenceDepth !== null) collectLinks(child, references);
    const text = blockText(child);
    if (text) blocks.push({ text });
  }

  // Assemble plain text, recording section boundaries as exact character offsets.
  const sections: SectionDraft[] = [];
  const anchors = new Set<string>();
  let plainText = "";
  for (const block of blocks) {
    if (plainText) plainText += "\n\n";
    if (block.heading) {
      const previous = sections.at(-1);
      if (previous) previous.charEnd = plainText.length;
      sections.push({
        ordinal: sections.length,
        level: Math.min(6, Math.max(1, block.heading.depth)),
        heading: block.heading.text || null,
        anchor: headingAnchor(block.heading.text, anchors),
        charStart: plainText.length,
        charEnd: plainText.length,
      });
    } else if (sections.length === 0) {
      sections.push({
        ordinal: 0,
        level: 0,
        heading: null,
        anchor: headingAnchor("preamble", anchors),
        charStart: 0,
        charEnd: 0,
      });
    }
    plainText += block.text;
  }
  const last = sections.at(-1);
  if (last) last.charEnd = plainText.length;

  const markdown = toMarkdown(root, {
    extensions: [gfmToMarkdown()],
    bullet: "-",
    emphasis: "*",
    rule: "-",
  }).trim();
  const firstHeading = blocks.find((block) => block.heading)?.heading?.text ?? null;

  return { markdown, plainText, sections, references, firstHeading };
}
