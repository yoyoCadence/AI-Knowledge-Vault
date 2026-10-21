import { describe, expect, it } from "vitest";
import { firstParam, searchQueryParam } from "@/lib/search-params";

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
});
