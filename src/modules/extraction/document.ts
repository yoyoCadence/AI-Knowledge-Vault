import type { Nodes as MdastNodes, Root as MdastRoot, RootContent } from "mdast";
import { gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown } from "mdast-util-to-markdown";
import { toString } from "mdast-util-to-string";
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
      return node.children
        .map((row) => row.children.map((cell) => normalizeWhitespace(toString(cell))).join(" | "))
        .join("\n");
    default:
      return normalizeWhitespace(toString(node, { includeImageAlt: true }));
  }
}

function collectLinks(node: MdastNodes, out: ReferenceSource[]): void {
  if (out.length >= MAX_REFERENCES) return;
  if (node.type === "link" && /^https?:\/\//i.test(node.url)) {
    const title = normalizeWhitespace(toString(node));
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
      const text = normalizeWhitespace(toString(child));
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
