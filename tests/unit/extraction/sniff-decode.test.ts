import { describe, expect, it } from "vitest";
import {
  decodeText,
  detectLanguage,
  filenameStem,
  sniffFormat,
  summaryFromText,
} from "@/modules/extraction";
import { BIG5_SAMPLE, pdfDocument, pngImage } from "@tests/fixtures/builders";

const head = (value: string | Buffer) =>
  (typeof value === "string" ? Buffer.from(value) : value).subarray(0, 4096);

describe("sniffFormat", () => {
  it("detects binary formats by magic bytes regardless of the filename", async () => {
    expect(
      sniffFormat(head(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0])), "report.html").format,
    ).toBe("zip");
    expect(sniffFormat(head(pdfDocument()), "x.txt").format).toBe("pdf");
    expect(sniffFormat(head(await pngImage()), "photo.jpg").format).toBe("png");
    expect(sniffFormat(head(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "a.jpg").format).toBe("jpeg");
    expect(
      sniffFormat(head(Buffer.from("RIFF\x00\x00\x00\x00WEBPVP8 ", "latin1")), "a.webp").format,
    ).toBe("webp");
  });

  it("detects HTML by content (BOM, whitespace, comments) and by extension", () => {
    expect(sniffFormat(head("\uFEFF  <!DOCTYPE html><html>"), "notes.txt").format).toBe("html");
    expect(sniffFormat(head("<!-- generated --><html lang=en>"), "x").format).toBe("html");
    expect(sniffFormat(head("<p>fragment</p>"), "page.htm").format).toBe("html");
  });

  it("uses the extension to choose between text formats", () => {
    expect(sniffFormat(head("# Title"), "notes.md").format).toBe("markdown");
    expect(sniffFormat(head("plain words"), "notes.txt").format).toBe("text");
  });

  it("rejects binary garbage and text with unsupported extensions", () => {
    expect(sniffFormat(head(Buffer.from([0x00, 0x01, 0x02, 0x03])), "x.bin").format).toBe(
      "unknown",
    );
    expect(sniffFormat(head("not really a pdf"), "fake.pdf").format).toBe("unknown");
  });
});

describe("decodeText", () => {
  it("handles UTF-8 with and without BOM", () => {
    expect(decodeText(Buffer.from("\uFEFF繁體中文")).text).toBe("繁體中文");
    expect(decodeText(Buffer.from("繁體中文"))).toMatchObject({
      text: "繁體中文",
      encoding: "utf-8",
      warnings: [],
    });
  });

  it("handles UTF-16 LE with BOM", () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("知識", "utf16le")]);
    expect(decodeText(bytes)).toMatchObject({ text: "知識", encoding: "utf-16le" });
  });

  it("falls back to Big5 with a visible warning", () => {
    const decoded = decodeText(BIG5_SAMPLE);
    expect(decoded.text).toBe("中文測試");
    expect(decoded.encoding).toBe("big5");
    expect(decoded.warnings[0]).toMatch(/TEXT_ENCODING_FALLBACK/);
  });
});

describe("detectLanguage", () => {
  it("distinguishes Traditional and Simplified Chinese", () => {
    expect(
      detectLanguage(
        "這個問題的研究結果顯示，我們對於城市熱島的理解還不夠完整，需要更多實驗與資料。",
      ),
    ).toBe("zh-Hant");
    expect(
      detectLanguage(
        "这个问题的研究结果显示，我们对于城市热岛的理解还不够完整，需要更多实验与资料。",
      ),
    ).toBe("zh-Hans");
  });

  it("detects English, Japanese and undetermined text", () => {
    expect(
      detectLanguage("Urban heat builds up where pavement replaces trees in most dense cities."),
    ).toBe("en");
    expect(detectLanguage("これはテストの文章です。ひらがなとカタカナがあります。")).toBe("ja");
    expect(detectLanguage("1234 5678")).toBe("und");
  });

  it("trusts a declaration unless the content contradicts its script family", () => {
    expect(detectLanguage("這個問題的研究結果顯示我們的理解還不夠完整需要更多資料", "zh-TW")).toBe(
      "zh-Hant",
    );
    expect(detectLanguage("這個問題的研究結果顯示我們的理解還不夠完整需要更多資料", "en")).toBe(
      "zh-Hant",
    );
    expect(detectLanguage("short", "fr")).toBe("fr");
  });
});

describe("filenameStem", () => {
  it.each([
    ["Urban Heat Report.dc.html", "Urban Heat Report"],
    ["archive.tar.gz", "archive"],
    ["notes.md", "notes"],
    ["dir/sub/報告.pdf", "報告"],
    ["noext", "noext"],
  ])("%s → %s", (input, expected) => {
    expect(filenameStem(input)).toBe(expected);
  });
});

describe("summaryFromText", () => {
  it("takes the first line long enough to say something, other than the title", () => {
    const title = "一份相當長的研究報告標題：都市熱島";
    const text = `${title}\n短句\n  都市熱島效應使市中心比郊區更熱，本報告整理成因與對策。  \n其他`;
    expect(summaryFromText(text, title)).toBe(
      "都市熱島效應使市中心比郊區更熱，本報告整理成因與對策。",
    );
    expect(summaryFromText(`${title}\n短句`, title)).toBeNull();
    expect(summaryFromText(`${title}${title}`, null)).toBe(`${title}${title}`);
    expect(summaryFromText("長".repeat(300))).toBe(`${"長".repeat(279)}…`);
  });
});
