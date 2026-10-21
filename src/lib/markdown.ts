import type { Nodes, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

/**
 * Markdown parsing shared by the reader and by note validation (docs/SECURITY.md §5).
 *
 * Some Markdown costs a parser far more than its size: deeply nested containers or emphasis
 * make micromark's work grow quadratically and recursion overflow the stack (a 20 KB note of
 * `- - - …` blocks for about a minute). Text people write here (notes) is therefore checked
 * before it is stored: `markdownProblem` runs a linear scan of the structures that cause this,
 * then parses and bounds the tree's depth. What passes parses in about a second at most.
 */

export const MARKDOWN_MAX_DEPTH = 64;
/** Block-quote and list markers opening one line. */
const MAX_LINE_NESTING = 8;
/** Leading whitespace, in columns (a tab counts 4): bounds nesting by indentation. */
const MAX_INDENT = 64;
/** Consecutive emphasis delimiters (`*`, `_`, `~`, mixed). */
const MAX_DELIMITER_RUN = 32;
/**
 * Emphasis delimiter runs and brackets in one stretch of inline text: emphasis cannot span a
 * blank line, a list item, a quote, a heading or a table row, so each of those starts afresh.
 */
const MAX_BLOCK_DELIMITERS = 1_000;

export function parseMarkdown(markdown: string): Root {
  return fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

/** Depth of a tree, without recursion (the tree may be deep). */
export function markdownDepth(tree: Root): number {
  let deepest = 0;
  const pending: [Nodes, number][] = [[tree, 1]];
  while (pending.length > 0) {
    const [node, depth] = pending.pop()!;
    if (depth > deepest) deepest = depth;
    if ("children" in node) for (const child of node.children) pending.push([child, depth + 1]);
  }
  return deepest;
}

const CONTAINER_MARKER = /(?:>|[-*+](?=[ \t]|$)|\d{1,9}[.)](?=[ \t]|$))/y;

/** The linear part of `markdownProblem`. */
function scanProblem(text: string): string | null {
  let blockDelimiters = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      blockDelimiters = 0;
      continue;
    }
    let index = 0;
    let column = 0;
    let nesting = 0;
    for (;;) {
      while (line[index] === " " || line[index] === "\t") {
        column += line[index] === "\t" ? 4 : 1;
        index += 1;
      }
      if (column > MAX_INDENT) return "indented too deeply";
      CONTAINER_MARKER.lastIndex = index;
      const marker = CONTAINER_MARKER.exec(line);
      if (!marker) break;
      nesting += 1;
      if (nesting > MAX_LINE_NESTING) return "nested too deeply";
      index += marker[0].length;
      column += marker[0].length;
    }
    if (nesting > 0 || line[index] === "#" || line[index] === "|") blockDelimiters = 0;
    let run = 0;
    for (; index < line.length; index += 1) {
      const char = line[index];
      if (char === "*" || char === "_" || char === "~") {
        if (run === 0) blockDelimiters += 1;
        run += 1;
        if (run > MAX_DELIMITER_RUN) return "too many emphasis marks in a row";
      } else {
        run = 0;
        if (char === "[" || char === "]") blockDelimiters += 1;
      }
    }
    if (blockDelimiters > MAX_BLOCK_DELIMITERS) return "too many emphasis marks or brackets";
  }
  return null;
}

/**
 * Why `text` is too costly to parse and show as Markdown, or null when it is fine. Linear
 * checks first (they refuse the slow cases before anything parses them), then the parsed
 * tree's depth, which the renderer recurses through.
 */
export function markdownProblem(text: string): string | null {
  const problem = scanProblem(text);
  if (problem) return problem;
  return markdownDepth(parseMarkdown(text)) > MARKDOWN_MAX_DEPTH ? "nested too deeply" : null;
}
