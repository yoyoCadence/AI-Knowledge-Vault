import { describe, expect, it } from "vitest";
import { cleanDescription, cleanTitle } from "@/lib/text";

describe("cleanTitle / cleanDescription", () => {
  it("strips directional marks (ALM, LRM, RLM), the rest of the Bidi_Control set", () => {
    expect(cleanTitle("report\u200f.exe", 100)).toBe("report.exe");
    expect(cleanTitle("\u200ea \u061c b\u200f", 100)).toBe("a b");
    expect(cleanDescription("line\u200f one\r\nline two\u200e", 100)).toBe("line one\nline two");
  });

  it("refuses a title made only of directional marks", () => {
    for (const title of ["\u200e", "\u200f\u061c", " \u200e "]) {
      expect(() => cleanTitle(title, 100), JSON.stringify(title)).toThrow(/visible text/);
    }
    expect(cleanDescription("\u200f", 100)).toBeNull();
  });

  it("still refuses embeddings, overrides and isolates", () => {
    for (const text of ["abc\u202eexe.gpj", "a\u2066b\u2069", "a\u202ab"]) {
      expect(() => cleanTitle(text, 100), JSON.stringify(text)).toThrow();
      expect(() => cleanDescription(text, 100), JSON.stringify(text)).toThrow();
    }
  });
});
