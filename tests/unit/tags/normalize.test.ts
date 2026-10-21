import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { normalizeTagName } from "@/modules/tags";

describe("normalizeTagName (DATA_MODEL §4.4)", () => {
  it("keeps a readable display name and an identity folded by width, case and spacing", () => {
    expect(normalizeTagName("  ＡＩ　　Model ")).toEqual({
      name: "ＡＩ Model",
      normalizedName: "ai model",
    });
    expect(normalizeTagName("城市\t研究").normalizedName).toBe("城市 研究");
    // Zero-width characters cannot make two names that look the same differ.
    expect(normalizeTagName("a\u200bi").normalizedName).toBe(normalizeTagName("ai").normalizedName);
  });

  it("refuses empty, invisible, control-character and over-long names", () => {
    for (const bad of ["", "   ", "\u200b", "a\u0000b", "x".repeat(51)]) {
      expect(() => normalizeTagName(bad), JSON.stringify(bad)).toThrow(AppError);
    }
    // Names that render as nothing, or display as something else, are refused.
    for (const bad of [
      "\u200d",
      "\u200c",
      "\u00ad",
      "\u034f",
      "\u3164",
      "\u115f\u1160",
      "abc\u202eexe.gpj",
      "a\u2066b",
    ]) {
      expect(() => normalizeTagName(bad), JSON.stringify(bad)).toThrow(AppError);
    }
    // Blank glyphs are not visible either.
    for (const bad of ["\u2800", "\u2800\u2800\u2800", "\u{1d159}"]) {
      expect(() => normalizeTagName(bad), JSON.stringify(bad)).toThrow(AppError);
    }
    // An invisible character cannot make a second tag that looks like the first.
    for (const lookalike of ["a\u00adi", "a\u200di", "a\u034fi", "a\ufe0fi", "a\u2062i"]) {
      expect(normalizeTagName(lookalike).normalizedName, JSON.stringify(lookalike)).toBe("ai");
    }
    expect(normalizeTagName("a\u3164").normalizedName).toBe("a");
    expect(normalizeTagName("a\u2800").normalizedName).toBe("a");
    // Directional marks from pasted right-to-left text are dropped, not refused.
    expect(normalizeTagName("שלום\u200f").name).toBe("שלום");
    expect(normalizeTagName("C++\u200e עברית").name).toBe("C++ עברית");
    // Joiners inside visible text are fine (emoji sequences, Indic scripts).
    expect(normalizeTagName("👩\u200d💻").name).toBe("👩\u200d💻");
    // 50 characters counted as code points, so an emoji counts once.
    expect(normalizeTagName("😀".repeat(50)).name).toHaveLength(100);
  });
});
