import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { buildDocument } from "./document";
import { detectLanguage } from "./language";
import type { ExtractionResult, SourceMetadata } from "./types";

export const MARKDOWN_EXTRACTOR_VERSION = 1;

/**
 * Minimal YAML front matter reader (flat `key: value` pairs only). Unknown keys are ignored;
 * values are used only for the explicit metadata fields below — never inferred.
 */
export function parseFrontMatter(text: string): { data: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { data: {}, body: text };
  const data: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!pair) continue;
    const value = (pair[2] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2");
    if (value) data[(pair[1] ?? "").toLowerCase()] = value.slice(0, 2000);
  }
  return { data, body: text.slice(match[0].length) };
}

function metadataFrom(data: Record<string, string>): SourceMetadata {
  const metadata: SourceMetadata = {};
  const model = data.model ?? data.ai_model ?? data.llm;
  if (model) metadata.sourceModel = model.slice(0, 200);
  const platform = data.source_platform ?? data.platform;
  if (platform) metadata.sourcePlatform = platform.slice(0, 100);
  const date = /^\d{4}-\d{2}-\d{2}/.exec(data.date ?? data.research_date ?? "")?.[0];
  if (date) metadata.researchDate = date;
  if (data.author) metadata.author = data.author.slice(0, 200);
  const url = data.source_url ?? data.source ?? data.url;
  if (url && /^https?:\/\//i.test(url)) metadata.sourceUrl = url;
  const description = data.description ?? data.summary;
  if (description) metadata.description = description;
  return metadata;
}

export function extractMarkdown(
  text: string,
  options: { filenameStem: string; warnings?: string[] },
): ExtractionResult {
  const { data, body } = parseFrontMatter(text);
  const tree = fromMarkdown(body, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const parts = buildDocument(tree);
  const warnings = [...(options.warnings ?? [])];
  if (!parts.plainText) warnings.push("NO_TEXT_CONTENT: no readable text found");
  const title = data.title ?? parts.firstHeading ?? options.filenameStem;

  return {
    method: "markdown",
    version: MARKDOWN_EXTRACTOR_VERSION,
    status: parts.plainText ? "succeeded" : "partial",
    title: title ? title.slice(0, 500) : null,
    language: detectLanguage(parts.plainText, data.lang ?? data.language),
    plainText: parts.plainText,
    // Keep the author's Markdown (minus front matter) rather than a re-serialization.
    markdown: body.trim(),
    sections: parts.sections,
    metadata: metadataFrom(data),
    references: parts.references,
    warnings,
  };
}
