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
    expect(result.title).toBe("形態發生研究筆記");
    expect(result.language).toBe("zh-Hant");
    expect(result.sections.map((section) => section.heading)).toEqual([
      "形態發生研究筆記",
      "位置資訊",
      "自組織",
      "來源",
    ]);
    expect(result.references).toEqual([
      { title: "Turing 1952", url: "https://doi.org/10.1098/rstb.1952.0012" },
      { title: "Example paper", url: "https://example.org/paper" },
    ]);
    expect(result.metadata.description).toBe("胚胎發育中的圖案形成機制摘要。");
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
    expect(dc.result.title).toBe("胚胎沒有藍圖，只有規則");
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
    expect(result.plainText).toContain("Second page about morphogenesis");
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
