import { describe, expect, it } from "vitest";
import {
  extractHtml,
  extractMarkdown,
  extractPdf,
  extractPlainText,
  parseFrontMatter,
} from "@/modules/extraction";
import {
  claudeDesignDocument,
  htmlDocument,
  markdownDocument,
  pdfDocument,
} from "@tests/fixtures/builders";

describe("extractHtml", () => {
  const { result, analysis } = extractHtml(htmlDocument(), {
    filename: "note.html",
    filenameStem: "note",
  });

  it("extracts title, language, sections and references", () => {
    expect(result.title).toBe("城市熱島研究筆記");
    expect(result.language).toBe("zh-Hant");
    expect(result.sections.map((section) => section.heading)).toEqual([
      "城市熱島研究筆記",
      "位置資訊",
      "自組織",
      "來源",
    ]);
    expect(result.references).toEqual([
      { title: "Turing 1952", url: "https://doi.org/10.1098/rstb.1952.0012" },
      { title: "Example paper", url: "https://example.org/paper" },
    ]);
    expect(result.metadata.description).toBe("都市熱島效應的成因與對策摘要。");
    expect(analysis.hasScripts).toBe(true);
  });

  it("section offsets index exactly into the plain text", () => {
    for (const section of result.sections) {
      const slice = result.plainText.slice(section.charStart, section.charEnd);
      if (section.heading) expect(slice.startsWith(section.heading)).toBe(true);
    }
    expect(result.sections.at(-1)?.charEnd).toBe(result.plainText.length);
  });

  it("never surfaces scripts, styles, hidden content or form controls", () => {
    for (const forbidden of [
      "tracking",
      "font-family",
      "隱藏內容",
      "不應出現的按鈕",
      "<script",
      "onclick",
    ]) {
      expect(result.plainText).not.toContain(forbidden);
      expect(result.markdown).not.toContain(forbidden);
    }
    expect(result.markdown).toContain("| 機制 | 證據 |");
    expect(result.plainText).toContain("梯度 | 強");
  });

  it("recognises Claude Design documents and strips template bindings", () => {
    const dc = extractHtml(claudeDesignDocument(), {
      filename: "Morph.dc.html",
      filenameStem: "Morph",
    });
    expect(dc.analysis.isClaudeDesign).toBe(true);
    expect(dc.result.metadata.sourcePlatform).toBe("claude_design");
    expect(dc.result.title).toBe("城市沒有恆溫器，只有材料");
    expect(dc.result.plainText).not.toMatch(/\{\{|\}\}/);
    expect(dc.result.plainText).toContain("劑量實驗");
    expect(dc.result.plainText).not.toContain("DCLogic");
    expect(dc.analysis.externalHosts).toContain("fonts.googleapis.com");
  });

  it("does not guess a model from the generator meta tag", () => {
    const html =
      '<html><head><meta name="generator" content="Some Tool 1.0"><title>T</title></head><body><p>Body text long enough.</p></body></html>';
    const { result: r, analysis: a } = extractHtml(html, { filename: "t.html", filenameStem: "t" });
    expect(r.metadata.sourceModel).toBeUndefined();
    expect(a.generator).toBe("Some Tool 1.0");
  });
});

describe("extractHtml keeps a page's text, and its words apart", () => {
  const page = (body: string, title = "T") =>
    extractHtml(
      `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`,
      {
        filename: "page.html",
        filenameStem: "page",
      },
    ).result;

  it("keeps a page wrapped in a form (ASP.NET WebForms), but not its controls", () => {
    const result = page(
      `<form id="form1" method="post" action="./news.aspx">
        <input type="hidden" name="__VIEWSTATE" value="dDwtMTA4">
        <div><h1>公告事項</h1><p>本府公布新版補助辦法。</p></div>
        <button type="submit">送出查詢</button>
      </form>`,
    );
    expect(result.status).toBe("succeeded");
    expect(result.plainText).toBe("公告事項\n\n本府公布新版補助辦法。");
    expect(result.markdown).toContain("# 公告事項");
    expect(result.sections.map((section) => section.heading)).toEqual(["公告事項"]);
  });

  it("keeps an accordion's questions and its collapsed answers, and nothing else hidden", () => {
    const result = page(
      `<h3><button aria-expanded="false" aria-controls="a1">申請資格為何？</button></h3>
       <div id="a1" role="region" hidden><p>設籍滿一年者。</p></div>
       <button aria-expanded="false" aria-controls="a2 a3">More</button>
       <div id="a2" style="display: none">Second panel</div>
       <div hidden="until-found">Found by find-in-page</div>
       <div hidden>Not shown</div>
       <div style="display:none">Not shown either</div>
       <p>Copy<button type="button">Copy code</button>done</p>`,
    );
    expect(result.plainText).toBe(
      "申請資格為何？\n\n設籍滿一年者。\n\nMore\n\nSecond panel\n\nFound by find-in-page\n\nCopy done",
    );
    expect(result.sections.map((section) => section.heading)).toEqual(["申請資格為何？"]);
  });

  it("keeps words apart across line breaks, dropped controls, images and inline-styled boxes", () => {
    const cases: [string, string][] = [
      ["<p>Line one<br>Line two</p>", "Line one\nLine two"],
      ["<p>Click<button>Save</button>now</p>", "Click now"],
      ["<p>Email<input name=e>Phone<select><option>x</select>Fax</p>", "Email Phone Fax"],
      ["<p>Before<img alt=chart src=c.png>After</p>", "Before chart After"],
      ["<p>Icon<svg><text>logo</text></svg>Label</p>", "Icon Label"],
      [
        '<div style="display:flex"><span>Alpha</span><span>Beta</span>Gamma</div>',
        "Alpha Beta Gamma",
      ],
      [
        '<p><span style="display: block">Name</span><span style="display:block">Value</span></p>',
        "Name Value",
      ],
      ['<div style="display:grid"><span>標籤</span><span>數值</span></div>', "標籤 數值"],
      // Inline formatting inside a word is not a boundary.
      ["<p><b>W</b>ord, un<em>believ</em>able, 標<span>籤</span></p>", "Word, unbelievable, 標籤"],
      ['<p><span style="display:inline">in</span>line</p>', "inline"],
    ];
    for (const [body, text] of cases) expect(page(body).plainText, body).toBe(text);
  });

  it("strips Claude Design bindings inside flex and grid containers too", () => {
    const dc = (body: string) =>
      extractHtml(`<html><head><title>T</title></head><body>${body}</body></html>`, {
        filename: "card.dc.html",
        filenameStem: "card",
      }).result.plainText;
    expect(dc('<div style="display:flex">{{ selectedLabel }}</div><p>Body</p>')).toBe("Body");
    expect(dc('<div style="display:grid">Total: {{ total }}<span>NT$</span></div>')).toBe(
      "Total: NT$",
    );
    // Code keeps its braces, in a container or not.
    expect(dc('<div style="display:flex"><code>{{ x }}</code></div>')).toBe("{{ x }}");
  });

  it("gives a table without a header row no empty first line", () => {
    const result = page(
      "<table><tr><td>Price</td><td>Total</td></tr><tr><td>1</td><td>2</td></tr></table>",
    );
    expect(result.plainText).toBe("Price | Total\n1 | 2");
  });

  it("keeps section offsets exact around the new boundaries", () => {
    const result = page(
      `<h2>Intro<br>part</h2><p>a<button>x</button>b</p><h2>Next</h2><p>c<img alt=d>e</p>`,
    );
    expect(result.sections.map((section) => section.heading)).toEqual(["Intro part", "Next"]);
    for (const section of result.sections) {
      expect(result.plainText.slice(section.charStart).startsWith(section.heading ?? "")).toBe(
        true,
      );
    }
    expect(result.sections.at(-1)?.charEnd).toBe(result.plainText.length);
  });
});

describe("extractMarkdown", () => {
  it("reads front matter explicitly and builds sections and references", () => {
    const result = extractMarkdown(markdownDocument(), { filenameStem: "x" });
    expect(result.title).toBe("量化交易研究摘要");
    expect(result.metadata).toMatchObject({
      sourceModel: "example-model-1",
      researchDate: "2026-09-01",
      author: "Test Author",
    });
    expect(result.sections.map((section) => section.heading)).toEqual([
      "量化交易研究摘要",
      "動能效應",
      "參考資料",
    ]);
    expect(result.references[0]?.url).toBe("https://doi.org/10.1111/j.1540-6261.1993.tb04702.x");
    expect(result.markdown.startsWith("# 量化交易研究摘要")).toBe(true);
  });

  it("keeps words apart at hard breaks, and reads raw HTML tags as markup, not text", () => {
    const text = (markdown: string) => extractMarkdown(markdown, { filenameStem: "x" }).plainText;
    expect(text("Line one  \nLine two\n")).toBe("Line one\nLine two");
    expect(text("Line one\\\nLine two\n")).toBe("Line one\nLine two");
    expect(text("Press <kbd>Ctrl</kbd>+<kbd>C</kbd>, then a<br>b<br/>c\n")).toBe(
      "Press Ctrl+C, then a\nb\nc",
    );
    expect(text("| a | b |\n|---|---|\n| one<br>two | x |\n")).toBe("a | b\none two | x");
    expect(text("# Head<br>line\n\nBody ![chart](c.png)text\n")).toBe(
      "Head line\n\nBody chart text",
    );
    // Soft line breaks were already kept.
    expect(text("Line one\nLine two\n")).toBe("Line one\nLine two");
  });

  it("parseFrontMatter ignores documents without front matter", () => {
    expect(parseFrontMatter("# Hello")).toEqual({ data: {}, body: "# Hello" });
  });
});

describe("extractPlainText", () => {
  it("uses the first short line as title and one preamble section", () => {
    const result = extractPlainText("研究標題\n\n第一段內容。\n第二行。", {
      filenameStem: "fallback",
    });
    expect(result.title).toBe("研究標題");
    expect(result.sections).toEqual([
      {
        ordinal: 0,
        level: 0,
        heading: null,
        anchor: "preamble",
        charStart: 0,
        charEnd: result.plainText.length,
      },
    ]);
  });
});

describe("extractPdf", () => {
  it("extracts text per page with page sections and the document title", async () => {
    const result = await extractPdf(pdfDocument(), { filenameStem: "doc", maxPages: 100 });
    expect(result.status).toBe("succeeded");
    expect(result.title).toBe("Vault Test PDF");
    expect(result.sections.map((section) => section.heading)).toEqual(["第 1 頁", "第 2 頁"]);
    expect(result.plainText).toContain("Hello Vault PDF page one");
    expect(result.plainText).toContain("Second page about urban heat");
  });

  it("honours the page limit", async () => {
    const result = await extractPdf(pdfDocument(["one", "two", "three"]), {
      filenameStem: "doc",
      maxPages: 2,
    });
    expect(result.sections).toHaveLength(2);
    expect(result.warnings.join()).toMatch(/PDF_PAGE_LIMIT/);
  });
});
