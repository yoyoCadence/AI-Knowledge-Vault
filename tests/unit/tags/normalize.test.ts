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
    expect(normalizeTagName("a​i").normalizedName).toBe(normalizeTagName("ai").normalizedName);
  });

  it("refuses empty, invisible, control-character and over-long names", () => {
    for (const bad of ["", "   ", "​", "a\u0000b", "x".repeat(51)]) {
      expect(() => normalizeTagName(bad), JSON.stringify(bad)).toThrow(AppError);
    }
    // 50 characters counted as code points, so an emoji counts once.
    expect(normalizeTagName("😀".repeat(50)).name).toHaveLength(100);
  });
});
