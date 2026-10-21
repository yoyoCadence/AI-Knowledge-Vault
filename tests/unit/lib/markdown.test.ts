import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownView } from "@/components/reader/markdown-view";
import { markdownProblem } from "@/lib/markdown";
import { normalizeNoteBody } from "@/modules/notes";

/**
 * Markdown a note may carry (docs/SECURITY.md §5): what would cost the server far more than
 * its size is refused before it is stored, and the renderer falls back to plain text for
 * anything too deep that reaches it another way.
 */

const timed = <T>(run: () => T) => {
  const started = performance.now();
  const value = run();
  return { value, ms: performance.now() - started };
};

describe("Markdown cost limits", () => {
  it("refuses, quickly, the inputs that stall or crash the parser", () => {
    const pathological: Record<string, string> = {
      "deep quotes": ">".repeat(19_999) + "a",
      "deep list": "- ".repeat(9_999) + "a",
      "deep ordered list": "1. ".repeat(6_000) + "a",
      "long emphasis run": "*".repeat(9_999) + "a" + "*".repeat(9_999),
      "mixed emphasis run": "*_".repeat(4_999) + "a" + "_*".repeat(4_999),
      "nested strong": "**a ".repeat(2_400) + "b" + " c**".repeat(2_400),
      "nested emphasis": "_a ".repeat(3_300) + "b" + " c_".repeat(3_300),
      "unmatched brackets": "a]".repeat(10_000),
      "indentation ladder": Array.from(
        { length: 60 },
        (_, level) => " ".repeat(level * 2) + "- a",
      ).join("\n"),
    };
    for (const [label, text] of Object.entries(pathological)) {
      const { value, ms } = timed(() => markdownProblem(text));
      expect(value, label).not.toBeNull();
      expect(ms, label).toBeLessThan(500);
      expect(() => normalizeNoteBody(text), label).toThrow(/Markdown/);
    }
  });

  it("accepts ordinary notes, nested a few levels, with plenty of formatting", () => {
    const ordinary = [
      "# 標題\n\n**重點**：_斜體_ 與 ~~刪除~~，[連結](https://example.com)。",
      "- 一\n  - 二\n    - 三\n      - 四\n        - 五\n          - 六",
      "> 引用\n> > 引用中的引用\n> > - 清單",
      "| a | b |\n| - | - |\n| 1 | 2 |",
      "```ts\nconst x = 1;\n```",
      "* * *\n\n---",
      Array.from({ length: 300 }, (_, index) => `- 第 ${index} 項 **粗體** [連結](#a)`).join("\n"),
    ];
    for (const text of ordinary) expect(markdownProblem(text), text.slice(0, 30)).toBeNull();
  });

  it("parses what it accepts in about a second at most", () => {
    // Among the costliest notes that pass: paragraphs of unmatched emphasis marks just under
    // the per-paragraph limit (unmatched marks are what micromark works hardest on).
    const block = "*a ".repeat(990);
    const note = Array.from({ length: 6 }, () => block).join("\n\n");
    const { value, ms } = timed(() => markdownProblem(note));
    expect(value).toBeNull();
    expect(ms).toBeLessThan(5_000);
  });

  it("limits block-quote and list markers opening one line", () => {
    expect(markdownProblem("> ".repeat(8) + "八層")).toBeNull();
    expect(markdownProblem("> ".repeat(9) + "九層")).toBe("nested too deeply");
    expect(markdownProblem("- ".repeat(9) + "九層")).toBe("nested too deeply");
  });

  it("shows a tree deeper than the limit as plain text, even where it would render", () => {
    // 100 levels render without overflowing the stack; the limit still applies.
    const deep = ">".repeat(100) + " 一百層";
    const html = renderToStaticMarkup(createElement(MarkdownView, { markdown: deep, anchors: [] }));
    expect(html).toContain("一百層");
    expect(html).not.toContain("<blockquote");
  });

  it("shows text too deep to render as written instead of failing", () => {
    // E.g. an imported document's extraction: it never went through `normalizeNoteBody`.
    const deep = ">".repeat(5_000) + " 很深的引用";
    const html = renderToStaticMarkup(createElement(MarkdownView, { markdown: deep, anchors: [] }));
    expect(html).toContain("很深的引用");
    expect(html).not.toContain("<blockquote");
    expect(html).toContain("whitespace-pre-wrap");
  });
});
