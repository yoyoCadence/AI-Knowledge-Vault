import { describe, expect, it } from "vitest";
import { buildSnippet, chunkText, parseQuery } from "@/modules/search";

describe("chunkText (SEARCH_DESIGN §3)", () => {
  it("keeps short sections whole, with exact offsets", () => {
    const text = "第一節內容。\n\n第二節內容。";
    const chunks = chunkText(text, [
      { ordinal: 0, charStart: 0, charEnd: 6 },
      { ordinal: 1, charStart: 8, charEnd: 14 },
    ]);
    expect(chunks.map((chunk) => [chunk.text, chunk.sectionOrdinal])).toEqual([
      ["第一節內容。", 0],
      ["第二節內容。", 1],
    ]);
    for (const chunk of chunks) expect(text.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.text);
  });

  it("splits long sections at sentence boundaries with overlap, never past the limit", () => {
    const sentence = "城市綠廊降低地表溫度。";
    const text = sentence.repeat(300); // 3,300 characters, one section
    const chunks = chunkText(text, [{ ordinal: 0, charStart: 0, charEnd: text.length }], {
      maxChars: 1_000,
      overlap: 100,
    });
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(1_000);
      expect(text.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.text);
    }
    // Ends on a sentence boundary, and the next chunk starts before it (overlap).
    expect(chunks[0]!.text.endsWith("。")).toBe(true);
    expect(chunks[1]!.charStart).toBeLessThan(chunks[0]!.charEnd);
    expect(chunks.at(-1)!.charEnd).toBe(text.length);
  });

  it("makes progress on text without any boundary, and skips blank ranges", () => {
    const text = "字".repeat(2_500);
    const chunks = chunkText(text, [], { maxChars: 1_000, overlap: 100 });
    expect(chunks[0]!.sectionOrdinal).toBeNull();
    expect(chunks.at(-1)!.charEnd).toBe(2_500);
    expect(chunkText("  \n\n  ", [])).toEqual([]);
  });

  it("never splits a surrogate pair at a cut or an overlap start", () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const cases = [
      "a".repeat(1_199) + "😀" + "b".repeat(500), // the default cut lands inside the emoji
      "😀".repeat(1_500), // every cut and overlap start lands on a pair
      "𠀋".repeat(900) + "。" + "𡈽".repeat(900), // CJK Extension B, with a boundary
    ];
    for (const text of cases) {
      const chunks = chunkText(text, []);
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.text).not.toMatch(lone);
        expect(text.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.text);
      }
      expect(chunks.at(-1)!.charEnd).toBe(text.length);
    }
  });
});

describe("buildSnippet (SEARCH_DESIGN §4)", () => {
  it("highlights matches with the index's normalization, at original offsets", () => {
    const snippet = buildSnippet("模型：ＡＩ Model 與 AI 應用", parseQuery("ai"));
    expect(snippet.segments.filter((s) => s.highlight).map((s) => s.text)).toEqual(["ＡＩ", "AI"]);
    expect(snippet.segments.map((s) => s.text).join("")).toBe("模型：ＡＩ Model 與 AI 應用");
  });

  it("matches words only at a word start; CJK anywhere", () => {
    const snippet = buildSnippet("retherm thermal 熱島效應", parseQuery("therm 熱島"));
    expect(snippet.segments.filter((s) => s.highlight).map((s) => s.text)).toEqual([
      "therm",
      "熱島",
    ]);
  });

  it("cuts about 160 characters around the first match and says so", () => {
    const text = `${"前".repeat(300)}透水鋪面${"後".repeat(300)}`;
    const snippet = buildSnippet(text, parseQuery("透水鋪面"));
    const shown = snippet.segments.map((s) => s.text).join("");
    expect([...shown]).toHaveLength(160);
    expect(shown).toContain("透水鋪面");
    expect(snippet).toMatchObject({ truncatedStart: true, truncatedEnd: true });
  });
});
