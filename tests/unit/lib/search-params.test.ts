import { describe, expect, it } from "vitest";
import { dayParam, firstParam, modelParam, searchQueryParam } from "@/lib/search-params";

describe("firstParam", () => {
  it("reads a repeated parameter (?q=a&q=b) as its first value, like URLSearchParams.get", () => {
    expect(firstParam(["a", "b"])).toBe("a");
    expect(firstParam("a")).toBe("a");
    expect(firstParam(undefined)).toBeUndefined();
    expect(firstParam([])).toBeUndefined();
  });

  it("cuts a long query by character, never inside a surrogate pair", () => {
    const query = searchQueryParam(`  城市${" ".repeat(197)}😀tail`);
    expect(query.endsWith("😀")).toBe(true);
    expect(() => encodeURIComponent(query)).not.toThrow();
    expect(Array.from(query).length).toBeLessThanOrEqual(200);
    expect(searchQueryParam(["  a  ", "b"])).toBe("a");
    expect(searchQueryParam(undefined)).toBe("");
  });

  it("keeps only days Postgres accepts", () => {
    expect(dayParam("2026-03-05")).toBe("2026-03-05");
    expect(dayParam(["2026-03-05", "x"])).toBe("2026-03-05");
    for (const bad of ["2026-02-30", "0000-01-01", "0000-02-29", "2026-3-5", "", undefined]) {
      expect(dayParam(bad), String(bad)).toBeUndefined();
    }
    expect(dayParam("0001-01-01")).toBe("0001-01-01");
  });

  it("keeps a source model exactly as recorded, without control characters", () => {
    expect(modelParam("  gpt-ws  ")).toBe("  gpt-ws  ");
    expect(modelParam("a\u0000b")).toBeUndefined();
    expect(modelParam("x".repeat(201))).toBeUndefined();
    expect(modelParam("")).toBeUndefined();
  });
});
