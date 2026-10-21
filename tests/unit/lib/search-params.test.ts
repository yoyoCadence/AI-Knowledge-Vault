import { describe, expect, it } from "vitest";
import { firstParam } from "@/lib/search-params";

describe("firstParam", () => {
  it("reads a repeated parameter (?q=a&q=b) as its first value, like URLSearchParams.get", () => {
    expect(firstParam(["a", "b"])).toBe("a");
    expect(firstParam("a")).toBe("a");
    expect(firstParam(undefined)).toBeUndefined();
    expect(firstParam([])).toBeUndefined();
  });
});
