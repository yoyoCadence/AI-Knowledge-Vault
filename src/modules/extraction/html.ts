import type { Element, ElementContent, Root as HastRoot, RootContent } from "hast";
import { toMdast } from "hast-util-to-mdast";
import { toText } from "hast-util-to-text";
import type { Root as MdastRoot } from "mdast";
import rehypeParse from "rehype-parse";
import { unified } from "unified";
import { buildDocument } from "./document";
import { detectLanguage } from "./language";
import { normalizeWhitespace } from "./normalize";
import type { ExtractionResult, SourceMetadata } from "./types";

/**
 * HTML → normalized content (ADR-010). Parsing never executes anything: rehype builds a syntax
 * tree only. Non-content and active elements are dropped before conversion, so reading mode can
 * never surface raw scripts, styles or embedded frames.
 */
/**
 * 2: forms and accordion headings and panels are kept; words around a dropped control, an
 * image or a line break stay apart.
 */
export const HTML_EXTRACTOR_VERSION = 2;

/** Never drawn: dropped without a trace. */
const INVISIBLE_ELEMENTS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "link",
  "meta",
  "base",
  "head",
  // Claude Design runtime: <helmet> holds stylesheet/script includes, not content.
  "helmet",
  "sc-helmet",
]);

/**
 * Drawn as a box of their own, but not content we keep: replaced by a space, so the words on
 * either side stay apart ("Click<button>Save</button>now" is "Click now", not "Clicknow").
 */
const BOX_ELEMENTS = new Set([
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "svg",
  "math",
  "canvas",
  "video",
  "audio",
  "source",
  "track",
  "input",
  "button",
  "select",
  "textarea",
]);

/**
 * A `<form>` is only a container: ASP.NET WebForms pages wrap their whole body in one, so it is
 * kept (its controls are dropped above). A `<button>` is kept as text when it names content:
 * in a heading (the WAI-ARIA accordion pattern) or as a disclosure toggle (`aria-expanded`).
 */
function keepsButton(element: Element, inHeading: boolean): boolean {
  return inHeading || attr(element, "ariaExpanded") !== null;
}

const HEADING = /^h[1-6]$/;

/**
 * What an inline `style` says about the element's box. Only inline styles are read (no
 * stylesheet is evaluated), but they are what generated pages (Claude Design among them)
 * mostly use. A block box, or any child of a flex or grid container, is laid out apart from
 * its neighbours: "<div style="display:flex"><span>Alpha</span><span>Beta</span></div>" reads
 * "Alpha Beta".
 */
function displayOf(element: Element): { block: boolean; container: boolean } {
  const style = attr(element, "style")?.replace(/\s+/g, "").toLowerCase() ?? "";
  const display = /(?:^|;)display:([a-z-]+)/.exec(style)?.[1] ?? "";
  return {
    block: /^(block|flex|grid|list-item|table|flow-root)$/.test(display),
    container: /^(inline-)?(flex|grid)$/.test(display),
  };
}

/** `{{ binding }}` placeholders used by Claude Design (dc) templates (ARCHITECTURE_REVIEW F-03). */
const TEMPLATE_BINDING = /\{\{\s*[^{}]{0,200}?\s*\}\}/g;

export interface HtmlAnalysis {
  isClaudeDesign: boolean;
  /** `<meta name="generator">`: the authoring software, not the AI model. */
  generator: string | null;
  declaredLanguage: string | null;
  externalHosts: string[];
  hasScripts: boolean;
}

function attr(element: Element, name: string): string | null {
  const value = element.properties?.[name];
  if (Array.isArray(value)) return value.join(" ");
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : null;
}

/**
 * Not drawn, so not content, with two exceptions that are content waiting to be shown:
 * `hidden="until-found"` (find-in-page reveals it) and the panel a collapsed accordion or
 * disclosure toggles (named by `aria-controls` on an element with `aria-expanded`).
 */
function isHidden(element: Element, panels: ReadonlySet<string>): boolean {
  const id = attr(element, "id");
  if (id && panels.has(id)) return false;
  const hidden = element.properties?.hidden;
  if (hidden !== undefined && hidden !== false && hidden !== "until-found") return true;
  if (attr(element, "ariaHidden") === "true") return true;
  const style = attr(element, "style")?.replace(/\s+/g, "").toLowerCase() ?? "";
  return style.includes("display:none") || style.includes("visibility:hidden");
}

/** The ids of the panels that disclosure toggles control. */
function disclosurePanels(tree: HastRoot): Set<string> {
  const panels = new Set<string>();
  walk(tree.children, (element) => {
    if (attr(element, "ariaExpanded") === null) return;
    for (const id of (attr(element, "ariaControls") ?? "").split(/\s+/)) if (id) panels.add(id);
  });
  return panels;
}

function walk(nodes: (RootContent | ElementContent)[], visit: (element: Element) => void): void {
  for (const node of nodes) {
    if (node.type === "element") {
      visit(node);
      walk(node.children, visit);
    }
  }
}

function hostOf(url: string | null): string | null {
  if (!url || !/^(https?:)?\/\//i.test(url)) return null;
  try {
    return new URL(url, "https://placeholder.invalid").host.toLowerCase();
  } catch {
    return null;
  }
}

/** Collects metadata and analysis facts from the full tree before any cleaning. */
function analyze(tree: HastRoot): {
  analysis: HtmlAnalysis;
  title: string | null;
  metadata: SourceMetadata;
} {
  let title: string | null = null;
  let declaredLanguage: string | null = null;
  let isClaudeDesign = false;
  let hasScripts = false;
  let generator: string | null = null;
  const hosts = new Set<string>();
  const metadata: SourceMetadata = {};

  walk(tree.children, (element) => {
    const tag = element.tagName.toLowerCase();
    if (tag === "html") declaredLanguage = attr(element, "lang");
    if (tag === "title" && title === null) title = normalizeWhitespace(toText(element)) || null;
    if (tag === "x-dc" || (tag === "script" && attr(element, "type") === "text/x-dc"))
      isClaudeDesign = true;
    if (tag === "script") hasScripts = true;
    if (tag === "script" || tag === "img" || tag === "iframe") {
      const host = hostOf(attr(element, "src"));
      if (host) hosts.add(host);
    }
    if (tag === "link") {
      const host = hostOf(attr(element, "href"));
      if (host) hosts.add(host);
    }
    if (tag === "meta") {
      const name = (attr(element, "name") ?? attr(element, "property") ?? "").toLowerCase();
      const content = normalizeWhitespace(attr(element, "content") ?? "");
      if (!content) return;
      if (name === "generator") generator = content.slice(0, 200);
      // Only an explicit model declaration fills source_model; it is never inferred.
      if (name === "ai-model" || name === "llm-model" || name === "model")
        metadata.sourceModel = content.slice(0, 200);
      if (name === "description" || name === "og:description")
        metadata.description ??= content.slice(0, 2000);
      if (name === "author") metadata.author = content.slice(0, 200);
      if (
        ["date", "dc.date", "article:published_time", "citation_publication_date"].includes(name)
      ) {
        const date = /^\d{4}-\d{2}-\d{2}/.exec(content)?.[0];
        if (date) metadata.researchDate = date;
      }
    }
  });

  return {
    analysis: {
      isClaudeDesign,
      generator,
      declaredLanguage,
      externalHosts: [...hosts].sort(),
      hasScripts,
    },
    title,
    metadata,
  };
}

interface CleanContext {
  stripBindings: boolean;
  panels: ReadonlySet<string>;
  inCode: boolean;
  inHeading: boolean;
  /** The parent is a flex or grid container: every child is a box of its own. */
  inContainer: boolean;
}

/** Removes non-content elements and (for dc templates) binding placeholders. Mutates the tree. */
function clean(
  nodes: (RootContent | ElementContent)[],
  context: CleanContext,
): (RootContent | ElementContent)[] {
  const out: (RootContent | ElementContent)[] = [];
  for (const node of nodes) {
    if (node.type === "comment" || node.type === "doctype") continue;
    if (node.type === "element") {
      const tag = node.tagName.toLowerCase();
      if (INVISIBLE_ELEMENTS.has(tag) || isHidden(node, context.panels)) continue;
      if (BOX_ELEMENTS.has(tag) && !(tag === "button" && keepsButton(node, context.inHeading))) {
        out.push({ type: "text", value: " " });
        continue;
      }
      const display = displayOf(node);
      node.children = clean(node.children, {
        ...context,
        inCode: context.inCode || tag === "code" || tag === "pre",
        inHeading: context.inHeading || HEADING.test(tag),
        inContainer: display.container,
      }) as ElementContent[];
      const apart = display.block || context.inContainer;
      if (apart) out.push({ type: "text", value: " " });
      out.push(node);
      if (apart) out.push({ type: "text", value: " " });
      continue;
    }
    if (node.type === "text" && context.inContainer && node.value.trim()) {
      // A flex or grid container's bare text is an anonymous box of its own.
      out.push({ type: "text", value: " " }, node, { type: "text", value: " " });
      continue;
    }
    if (node.type === "text" && context.stripBindings && !context.inCode) {
      const value = node.value.replace(TEMPLATE_BINDING, "");
      if (value.trim() === "" && node.value.trim() !== "") continue;
      out.push({ ...node, value });
      continue;
    }
    out.push(node);
  }
  return out;
}

export function extractHtml(
  html: string,
  options: { filename: string; filenameStem: string },
): {
  result: ExtractionResult;
  analysis: HtmlAnalysis;
} {
  const tree = unified().use(rehypeParse, { fragment: false }).parse(html) as HastRoot;
  const { analysis, title: documentTitle, metadata } = analyze(tree);
  const isClaudeDesign = analysis.isClaudeDesign || /\.dc\.html?$/i.test(options.filename);
  if (isClaudeDesign) metadata.sourcePlatform = "claude_design";

  tree.children = clean(tree.children, {
    stripBindings: isClaudeDesign,
    panels: disclosurePanels(tree),
    inCode: false,
    inHeading: false,
    inContainer: false,
  }) as RootContent[];
  const mdast = toMdast(tree) as MdastRoot;
  const parts = buildDocument(mdast);

  const warnings: string[] = [];
  if (analysis.hasScripts)
    warnings.push(
      "SCRIPTS_IGNORED: scripts are never executed; interactive parts are not extracted",
    );
  if (analysis.externalHosts.length > 0) {
    warnings.push(`EXTERNAL_DEPENDENCIES: ${analysis.externalHosts.join(", ")}`);
  }
  if (!parts.plainText) warnings.push("NO_TEXT_CONTENT: no readable text found");

  const title = documentTitle || parts.firstHeading || options.filenameStem || null;
  return {
    analysis: { ...analysis, isClaudeDesign },
    result: {
      method: "html",
      version: HTML_EXTRACTOR_VERSION,
      status: parts.plainText ? "succeeded" : "partial",
      title: title ? title.slice(0, 500) : null,
      language: detectLanguage(parts.plainText, analysis.declaredLanguage),
      plainText: parts.plainText,
      markdown: parts.markdown,
      sections: parts.sections,
      metadata,
      references: parts.references,
      warnings,
    },
  };
}
