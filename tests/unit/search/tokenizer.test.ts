import { describe, expect, it } from "vitest";
import {
  indexTokens,
  normalizeForSearch,
  parseQuery,
  termTsqueries,
  toTsquery,
  toTsvector,
} from "@/modules/search/tokenizer";

const query = (text: string) => toTsquery(parseQuery(text));

describe("search tokenizer (SEARCH_DESIGN §2)", () => {
  it("normalizes full-width and case", () => {
    expect(normalizeForSearch("ＡＩ　Ｍｏｄｅｌ")).toBe("ai model");
  });

  it("indexes CJK runs as bigrams and unigrams at consecutive positions", () => {
    expect(indexTokens("城市熱島")).toEqual([
      { lexeme: "城", position: 1 },
      { lexeme: "城市", position: 1 },
      { lexeme: "市", position: 2 },
      { lexeme: "市熱", position: 2 },
      { lexeme: "熱", position: 3 },
      { lexeme: "熱島", position: 3 },
      { lexeme: "島", position: 4 },
    ]);
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
    ).toBe("'熱':1A,102C '熱島':1A '島':2A");
  });

  it("truncates long words by code point, never inside a surrogate pair", () => {
    const word = "𐐨".repeat(70); // Deseret letters: \p{L}, outside the BMP
    const [token] = indexTokens(word);
    expect([...token!.lexeme]).toHaveLength(64);
    expect(token!.lexeme).toBe("𐐨".repeat(64));
  });

  it("turns CJK runs into adjacency phrases and words into prefixes", () => {
    expect(query("城市熱島")).toBe("('城市' <-> '市熱' <-> '熱島')");
    expect(query("熱島")).toBe("'熱島'");
    expect(query("熱")).toBe("'熱'");
    expect(query("therm")).toBe("'therm':*");
    expect(query("ＡＩ 熱島")).toBe("'ai':* & '熱島'");
    expect(query('"urban heat" 島')).toBe("('urban' <2> 'heat') & '島'");
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
    expect(termTsqueries(parseQuery('城市熱島 ai "urban heat"'))).toEqual([
      "('城市' <-> '市熱' <-> '熱島')",
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
