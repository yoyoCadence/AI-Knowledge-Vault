import { describe, expect, it } from "vitest";
import { T2S_PAIRS } from "@/modules/search/fold-data";
import {
  foldScript,
  indexTokens,
  normalizeForSearch,
  parseQuery,
  termTsqueries,
  toTsquery,
  toTsvector,
} from "@/modules/search/tokenizer";
import { buildSnippet } from "@/modules/search/query";

const query = (text: string) => toTsquery(parseQuery(text));

describe("search tokenizer (SEARCH_DESIGN §2)", () => {
  it("leaves out tokens past the last tsvector position instead of piling them up there", () => {
    let seed = 2_463_534_242; // xorshift32: distinct characters, ~one position each
    const long = Array.from({ length: 17_000 }, () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return String.fromCodePoint(0x4e00 + ((seed >>> 0) % 20_000));
    }).join("");
    const vector = toTsvector([
      { text: long, weight: "C" },
      { text: "城市熱島", weight: "A" },
    ]);
    const positions = [...vector.matchAll(/(\d+)[ABCD]/g)].map((match) => Number(match[1]));
    expect(Math.max(...positions)).toBeLessThanOrEqual(16_383);
    // Postgres would clamp later positions to 16,383, where no phrase can match: at most the
    // tokens of one character sit there, never the tail of the text.
    expect(positions.filter((position) => position === 16_383).length).toBeLessThanOrEqual(2);
    // A part that starts past the end is not indexed at all.
    expect(vector).not.toMatch(/\d+A/);
  });

  it("normalizes full-width and case", () => {
    expect(normalizeForSearch("ＡＩ　Ｍｏｄｅｌ")).toBe("ai model");
  });

  it("indexes CJK runs as bigrams and unigrams at consecutive positions (folded)", () => {
    expect(indexTokens("城市熱島")).toEqual([
      { lexeme: "城", position: 1 },
      { lexeme: "城市", position: 1 },
      { lexeme: "市", position: 2 },
      { lexeme: "市热", position: 2 },
      { lexeme: "热", position: 3 },
      { lexeme: "热岛", position: 3 },
      { lexeme: "岛", position: 4 },
    ]);
  });

  it("folds Traditional and Simplified to the same lexemes, character by character", () => {
    expect(indexTokens("形態")).toEqual(indexTokens("形态"));
    expect(normalizeForSearch("臺灣的資訊網絡")).toBe("台湾的资讯网络");
    // Characters both scripts use are not merged with others (OpenCC's character table).
    expect(normalizeForSearch("著作")).toBe("著作");
    // One code point for one: offsets into the original text stay valid.
    const text = "都市熱島效應與資訊網絡";
    expect([...normalizeForSearch(text)]).toHaveLength([...text].length);
  });

  it("folds idempotently, so a query matches what indexing stored (chains like 薴 → 苧 → 苎)", () => {
    // Indexing folds once; a query folds its run and then tokenizes it, folding again.
    for (const char of Array.from(T2S_PAIRS)) {
      expect(foldScript(foldScript(char)), char).toBe(foldScript(char));
    }
    const indexed = new Set(indexTokens("薴麻").map((token) => token.lexeme));
    const [term] = parseQuery("薴麻");
    for (const token of term!.tokens) expect(indexed, token.lexeme).toContain(token.lexeme);
    expect(query("薴麻")).toBe("('苎麻' | '薴麻')");
  });

  it("matches a Traditional query also in its literal form, for not yet re-indexed text", () => {
    // Simplified is already folded: nothing to add.
    expect(query("形态")).toBe("'形态'");
    expect(query("形態")).toBe("('形态' | '形態')");
    const [term] = parseQuery("形態");
    expect(term!.highlights).toEqual(["形态"]);
  });

  it("highlights the original text whichever script the query uses", () => {
    for (const q of ["热岛", "熱島"]) {
      const snippet = buildSnippet("城市的熱島效應很明顯", parseQuery(q));
      expect(snippet.segments.filter((segment) => segment.highlight)).toEqual([
        { text: "熱島", highlight: true },
      ]);
    }
  });

  it("separates runs: words, CJK and punctuation each advance the position", () => {
    expect(indexTokens("AI模型, v2 版")).toEqual([
      { lexeme: "ai", position: 1 },
      { lexeme: "模", position: 2 },
      { lexeme: "模型", position: 2 },
      { lexeme: "型", position: 3 },
      { lexeme: "v2", position: 5 },
      { lexeme: "版", position: 7 },
    ]);
  });

  it("writes a weighted tsvector literal with parts kept apart", () => {
    // The next part starts 100 positions on: no phrase distance reaches across.
    expect(
      toTsvector([
        { text: "熱島", weight: "A" },
        { text: "熱", weight: "C" },
      ]),
    ).toBe("'热':1A,102C '热岛':1A '岛':2A");
  });

  it("truncates long words by code point, never inside a surrogate pair", () => {
    const word = "𐐨".repeat(70); // Deseret letters: \p{L}, outside the BMP
    const [token] = indexTokens(word);
    expect([...token!.lexeme]).toHaveLength(64);
    expect(token!.lexeme).toBe("𐐨".repeat(64));
  });

  it("turns CJK runs into adjacency phrases and words into prefixes", () => {
    expect(query("城市热岛")).toBe("('城市' <-> '市热' <-> '热岛')");
    expect(query("热岛")).toBe("'热岛'");
    expect(query("热")).toBe("'热'");
    expect(query("therm")).toBe("'therm':*");
    expect(query("ＡＩ 热岛")).toBe("'ai':* & '热岛'");
    expect(query('"urban heat" 岛')).toBe("('urban' <2> 'heat') & '岛'");
    // Traditional: the folded phrase, or the literal one.
    expect(query("城市熱島")).toBe(
      "(('城市' <-> '市热' <-> '热岛') | ('城市' <-> '市熱' <-> '熱島'))",
    );
    expect(query('"urban heat" 島')).toBe("('urban' <2> 'heat') & ('岛' | '島')");
  });

  it("cannot be steered into tsquery syntax by the user", () => {
    for (const hostile of ["a' | 'b", "!x & y", "a:* <-> (b)", "\\' OR 1=1 --", "x'y"]) {
      const result = query(hostile)!;
      const lexemes = [...result.matchAll(/'([^']*)'/g)].map((match) => match[1]);
      expect(lexemes.length, hostile).toBeGreaterThan(0);
      for (const lexeme of lexemes) expect(lexeme, hostile).toMatch(/^[\p{L}\p{N}]+$/u);
      // Outside the quoted lexemes only our own operators remain.
      expect(result.replace(/'[^']*'/g, ""), hostile).toMatch(/^[\s:*&<>\-()0-9]*$/);
    }
    expect(query("''''")).toBeNull();
    expect(query("   ,,, ！？ ")).toBeNull();
    expect(query("")).toBeNull();
  });

  it("gives each term its own tsquery, so terms can match in different places", () => {
    expect(termTsqueries(parseQuery('城市热岛 ai "urban heat"'))).toEqual([
      "('城市' <-> '市热' <-> '热岛')",
      "'ai':*",
      "('urban' <2> 'heat')",
    ]);
    expect(termTsqueries(parseQuery("  ！？ "))).toEqual([]);
  });

  it("caps the number of terms", () => {
    const many = Array.from({ length: 30 }, (_, index) => `w${index}`).join(" ");
    expect(parseQuery(many)).toHaveLength(16);
  });
});
