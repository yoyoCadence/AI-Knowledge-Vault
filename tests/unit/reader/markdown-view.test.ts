import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  headingAnchors,
  MarkdownView,
  PlainTextView,
  safeHref,
} from "@/components/reader/markdown-view";
import { extractHtml, extractMarkdown, extractPdf } from "@/modules/extraction";
import {
  claudeDesignDocument,
  htmlDocument,
  markdownDocument,
  pdfDocument,
} from "@tests/fixtures/builders";

const render = (markdown: string, anchors: string[] = []) =>
  renderToStaticMarkup(createElement(MarkdownView, { markdown, anchors }));

describe("reading mode renderer (SECURITY.md §5 Reading mode)", () => {
  it("never passes raw HTML through", () => {
    const html = render(
      '<script>alert(1)</script>\n\nText <img src=x onerror="alert(2)"> <b>bold</b>\n\n<iframe src="https://evil.example"></iframe>',
    );
    // Only as escaped text: no real tag and no real attribute.
    expect(html).not.toMatch(/<(script|img|iframe|b)[\s>/]/i);
    expect(html).not.toMatch(/onerror="/);
    expect(html).toContain("onerror=&quot;alert(2)&quot;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("keeps only safe links, opened without referrer or opener", () => {
    const html = render(
      "[ok](https://example.org/a?b=1) [mail](mailto:a@example.org) [in-page](#sec) " +
        "[js](javascript:alert(1)) [data](data:text/html,<b>x</b>) [rel](../secret)",
    );
    expect(html).toContain(
      '<a href="https://example.org/a?b=1" class="text-primary break-words underline-offset-4 hover:underline" target="_blank" rel="noopener noreferrer nofollow">ok</a>',
    );
    expect(html).toContain('href="mailto:a@example.org"');
    expect(html).toMatch(/<a href="#sec" class="[^"]*">in-page<\/a>/);
    expect(html).not.toMatch(/javascript:|data:text|href="\.\.\/secret"/);
    expect(html).toContain("<span>js</span>");
  });

  it("resolves reference-style links through the same allow-list", () => {
    const html = render(
      "[ok][1] [bad][2] [Case][ABC] [none][9]\n\n[1]: https://example.org/ref\n[2]: javascript:alert(1)\n[abc]: https://example.org/case",
    );
    expect(html).toMatch(
      /<a href="https:\/\/example.org\/ref"[^>]*rel="noopener noreferrer nofollow">ok<\/a>/,
    );
    expect(html).toMatch(/<a href="https:\/\/example.org\/case"[^>]*>Case<\/a>/);
    expect(html).toContain("<span>bad</span>");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("[none][9]");
  });

  it("keeps footnotes: the reference and its text", () => {
    const html = render("城市綠廊[^1]\n\n[^1]: 依據 2024 年觀測。");
    expect(html).toContain('<sup class="text-muted-foreground">[1]</sup>');
    expect(html).toContain("依據 2024 年觀測。");
  });

  it("shows images as their alt text and loads nothing", () => {
    const html = render("![城市地圖](https://tracker.example/pixel.png) ![](x.png)");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("tracker.example");
    expect(html).toContain("［圖片：城市地圖］");
    expect(html).toContain("［圖片：未提供說明］");
  });

  it("renders structure: headings from h2, lists, tables, code", () => {
    const html = render(
      "# Title\n\n## Sub\n\n- a\n- [x] done\n\n1. one\n\n| k | v |\n|:-|-:|\n| a | 1 |\n\n```js\nconst x = '<b>';\n```",
      ["title", "sub"],
    );
    expect(html).toMatch(/<h2 id="title"[^>]*>Title<\/h2>/);
    expect(html).toMatch(/<h3 id="sub"[^>]*>Sub<\/h3>/);
    expect(html).toMatch(/<input type="checkbox"[^>]*disabled=""[^>]*checked=""/);
    expect(html).toMatch(/<th class="[^"]*text-left[^"]*">k<\/th>/);
    expect(html).toMatch(/<td class="[^"]*text-right[^"]*">1<\/td>/);
    expect(html).toContain("const x = &#x27;&lt;b&gt;&#x27;;");
  });

  it("gives anchors only to root-level headings, in order", () => {
    const html = render("> # quoted\n\n# first\n\n# second", ["first", "second"]);
    expect(html).toMatch(/<h2 class="[^"]*">quoted<\/h2>/);
    expect(html).toMatch(/<h2 id="first"/);
    expect(html).toMatch(/<h2 id="second"/);
  });

  it("plain text is shown as written, never as Markdown or HTML", () => {
    const html = renderToStaticMarkup(
      createElement(PlainTextView, { text: "# not a heading\n<b>not bold</b>" }),
    );
    expect(html).not.toContain("<h2");
    expect(html).toContain("# not a heading\n&lt;b&gt;not bold&lt;/b&gt;");
  });

  it("safeHref allows only http(s), mailto and in-page targets", () => {
    expect(safeHref("HTTPS://Example.org/x")).toBe("https://example.org/x");
    expect(safeHref("#a")).toBe("#a");
    for (const unsafe of [
      "javascript:alert(1)",
      " JavaScript:alert(1)",
      "data:,x",
      "vbscript:x",
      "/a",
      "a.html",
      "//evil.example",
    ]) {
      expect(safeHref(unsafe), unsafe).toBeNull();
    }
  });
});

describe("table of contents anchors match the rendered headings", () => {
  const ids = (html: string) => [...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);

  it.each([
    ["HTML", () => extractHtml(htmlDocument(), { filename: "n.html", filenameStem: "n" }).result],
    [
      "Claude Design",
      () =>
        extractHtml(claudeDesignDocument(), { filename: "d.dc.html", filenameStem: "d" }).result,
    ],
    ["Markdown", () => extractMarkdown(markdownDocument(), { filenameStem: "m" })],
    [
      "Markdown with an empty heading",
      () => extractMarkdown("#\n\nlost text\n\n# Visible\n\nbody\n", { filenameStem: "e" }),
    ],
  ])("%s", (_name, extract) => {
    const result = extract();
    const anchors = headingAnchors(result.sections);
    expect(anchors.length).toBeGreaterThan(0);
    expect(ids(render(result.markdown, anchors))).toEqual(anchors);
  });

  it("an empty heading keeps its anchor, so the next heading gets its own", () => {
    const result = extractMarkdown("#\n\nlost text\n\n# Visible\n\nbody\n", { filenameStem: "e" });
    const visible = result.sections.find((section) => section.heading === "Visible")!;
    const html = render(result.markdown, headingAnchors(result.sections));
    expect(html).toMatch(new RegExp(`<h2 id="${visible.anchor}"[^>]*>Visible</h2>`));
  });

  it("PDF pages", async () => {
    const result = await extractPdf(pdfDocument(), { filenameStem: "p", maxPages: 10 });
    const anchors = headingAnchors(result.sections);
    expect(anchors).toEqual(["page-1", "page-2"]);
    expect(ids(render(result.markdown, anchors))).toEqual(anchors);
  });
});
