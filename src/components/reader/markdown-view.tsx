import type { Nodes, TableCell, TableRow } from "mdast";
import type { ReactNode } from "react";
import { t } from "@/lib/i18n";
import { MARKDOWN_MAX_DEPTH, markdownDepth, parseMarkdown } from "@/lib/markdown";

/**
 * Reading mode (docs/SECURITY.md §5 "Reading mode", FR-LIB-4): renders our own normalized
 * Markdown through an allow-list of node types into React elements. Nothing is ever passed
 * through as HTML: raw HTML in the source is shown as text, only http(s)/mailto and in-page
 * links stay links (with rel="noopener noreferrer nofollow"), and images are shown as their
 * alt text so reading never loads anything from elsewhere. `dangerouslySetInnerHTML` is
 * banned in this folder by lint.
 */

export { parseMarkdown };

/**
 * Anchors for `MarkdownView`: the stored sections that are headings (level > 0; a preamble is
 * level 0), in order. Not filtered by heading text: an empty heading still has a section and
 * still renders as a heading, so dropping it would shift every later anchor.
 */
export function headingAnchors(sections: { level: number; anchor: string }[]): string[] {
  return sections.filter((section) => section.level > 0).map((section) => section.anchor);
}

/** Link targets that stay clickable; anything else (javascript:, data:, relative) is text. */
export function safeHref(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed.startsWith("#")) return trimmed;
  try {
    const parsed = new URL(trimmed);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

interface RenderContext {
  /** Anchors for the root-level headings, in order (from the stored document sections). */
  anchors: string[];
  nextAnchor: number;
  /** Reference-style link targets (`[text][id]` + `[id]: url`), by normalized identifier. */
  definitions: Map<string, string>;
}

/** Collects `[id]: url` definitions; identifiers compare case-insensitively (CommonMark). */
function collectDefinitions(node: Nodes, into: Map<string, string>) {
  if (node.type === "definition") {
    const id = node.identifier.toLowerCase();
    if (!into.has(id)) into.set(id, node.url);
  }
  if ("children" in node) for (const child of node.children) collectDefinitions(child, into);
  return into;
}

const HEADING_CLASS: Record<number, string> = {
  2: "mt-10 mb-4 scroll-mt-20 text-xl font-semibold tracking-tight sm:text-2xl",
  3: "mt-8 mb-3 scroll-mt-20 text-lg font-semibold",
  4: "mt-6 mb-2 scroll-mt-20 text-base font-semibold",
  5: "mt-6 mb-2 scroll-mt-20 text-sm font-semibold",
  6: "mt-6 mb-2 scroll-mt-20 text-sm font-semibold text-muted-foreground",
};

function children(node: { children: Nodes[] }, ctx: RenderContext): ReactNode[] {
  return node.children.map((child, index) => render(child, ctx, index, false));
}

function cellAlign(align: string | null | undefined) {
  return align === "center" ? "text-center" : align === "right" ? "text-right" : "text-left";
}

function render(node: Nodes, ctx: RenderContext, key: number, root: boolean): ReactNode {
  switch (node.type) {
    case "root":
      return node.children.map((child, index) => render(child, ctx, index, true));
    case "heading": {
      // The page title is the h1, so document headings start at h2.
      const level = Math.min(6, node.depth + 1) as 2 | 3 | 4 | 5 | 6;
      const Tag = `h${level}` as const;
      const id = root ? ctx.anchors[ctx.nextAnchor++] : undefined;
      return (
        <Tag key={key} id={id} className={HEADING_CLASS[level]}>
          {children(node, ctx)}
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p key={key} className="my-4 leading-7">
          {children(node, ctx)}
        </p>
      );
    case "text":
      return node.value;
    case "emphasis":
      return <em key={key}>{children(node, ctx)}</em>;
    case "strong":
      return (
        <strong key={key} className="font-semibold">
          {children(node, ctx)}
        </strong>
      );
    case "delete":
      return <del key={key}>{children(node, ctx)}</del>;
    case "inlineCode":
      return (
        <code key={key} className="bg-surface-muted rounded px-1 py-0.5 font-mono text-[0.9em]">
          {node.value}
        </code>
      );
    case "code":
      return (
        <pre
          key={key}
          className="bg-surface-muted my-4 overflow-x-auto rounded-md p-4 font-mono text-sm leading-6"
        >
          <code>{node.value}</code>
        </pre>
      );
    case "html":
      // Raw HTML is never rendered: show its source, as text.
      return (
        <code key={key} className="text-muted-foreground font-mono text-xs break-all">
          {node.value}
        </code>
      );
    case "blockquote":
      return (
        <blockquote
          key={key}
          className="border-border text-muted-foreground my-4 border-l-4 pl-4 italic"
        >
          {children(node, ctx)}
        </blockquote>
      );
    case "list": {
      const items = children(node, ctx);
      return node.ordered ? (
        <ol key={key} start={node.start ?? undefined} className="my-4 list-decimal pl-6">
          {items}
        </ol>
      ) : (
        <ul key={key} className="my-4 list-disc pl-6">
          {items}
        </ul>
      );
    }
    case "listItem":
      return (
        <li key={key} className="my-1 leading-7 [&>p]:my-1">
          {node.checked === null || node.checked === undefined ? null : (
            <input type="checkbox" checked={node.checked} disabled className="mr-2 align-middle" />
          )}
          {children(node, ctx)}
        </li>
      );
    case "thematicBreak":
      return <hr key={key} className="border-border my-8" />;
    case "break":
      return <br key={key} />;
    case "link": {
      const href = safeHref(node.url);
      if (!href) return <span key={key}>{children(node, ctx)}</span>;
      const external = !href.startsWith("#");
      return (
        <a
          key={key}
          href={href}
          className="text-primary break-words underline-offset-4 hover:underline"
          {...(external ? { target: "_blank", rel: "noopener noreferrer nofollow" } : {})}
        >
          {children(node, ctx)}
        </a>
      );
    }
    case "image":
    case "imageReference":
      return (
        <span
          key={key}
          className="border-border text-muted-foreground my-2 inline-block rounded border border-dashed px-2 py-1 text-xs"
        >
          {t("reader.image", { alt: node.alt || t("reader.imageNoAlt") })}
        </span>
      );
    case "linkReference": {
      const url = ctx.definitions.get(node.identifier.toLowerCase());
      const href = url === undefined ? null : safeHref(url);
      if (!href) return <span key={key}>{children(node, ctx)}</span>;
      return (
        <a
          key={key}
          href={href}
          className="text-primary break-words underline-offset-4 hover:underline"
          {...(href.startsWith("#")
            ? {}
            : { target: "_blank", rel: "noopener noreferrer nofollow" })}
        >
          {children(node, ctx)}
        </a>
      );
    }
    case "footnoteReference":
      return (
        <sup key={key} className="text-muted-foreground">
          [{node.label ?? node.identifier}]
        </sup>
      );
    case "footnoteDefinition":
      return (
        <div key={key} className="text-muted-foreground my-2 flex gap-2 text-sm">
          <span>[{node.label ?? node.identifier}]</span>
          <div>{children(node, ctx)}</div>
        </div>
      );
    case "table": {
      const [head, ...body] = node.children as TableRow[];
      const cells = (row: TableRow, header: boolean) =>
        (row.children as TableCell[]).map((cell, index) => {
          const Cell = header ? "th" : "td";
          return (
            <Cell
              key={index}
              className={`border-border border px-3 py-2 align-top ${cellAlign(node.align?.[index])} ${header ? "font-semibold" : ""}`}
            >
              {children(cell, ctx)}
            </Cell>
          );
        });
      return (
        <div key={key} className="my-4 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            {head ? (
              <thead className="bg-surface-muted">
                <tr>{cells(head, true)}</tr>
              </thead>
            ) : null}
            <tbody>
              {body.map((row, index) => (
                <tr key={index}>{cells(row, false)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    default:
      // Definitions, YAML and anything unknown carry nothing to read.
      return null;
  }
}

/** The Markdown's elements, or null when it is too deep to render (or does not parse). */
function renderMarkdown(markdown: string, anchors: string[]): ReactNode | null {
  try {
    const tree = parseMarkdown(markdown);
    // `render` and `collectDefinitions` recurse once per level: a deeper tree could overflow
    // the stack.
    if (markdownDepth(tree) > MARKDOWN_MAX_DEPTH) return null;
    const ctx: RenderContext = {
      anchors,
      nextAnchor: 0,
      definitions: collectDefinitions(tree, new Map()),
    };
    return render(tree, ctx, 0, true);
  } catch {
    return null;
  }
}

/**
 * Renders normalized Markdown; root-level headings receive `anchors` as their ids, in order.
 * Text that cannot be rendered safely is shown as written: reading never fails because of
 * how a text is formatted.
 */
export function MarkdownView({ markdown, anchors }: { markdown: string; anchors: string[] }) {
  const content = renderMarkdown(markdown, anchors);
  if (content === null) return <PlainTextView text={markdown} />;
  return (
    <div className="text-foreground max-w-[72ch] text-[15px] break-words sm:text-base">
      {content}
    </div>
  );
}

/** Plain-text extractions are shown as written, never interpreted as Markdown. */
export function PlainTextView({ text }: { text: string }) {
  return (
    <div className="text-foreground max-w-[72ch] leading-7 break-words whitespace-pre-wrap">
      {text}
    </div>
  );
}
