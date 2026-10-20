import { describe, expect, it } from "vitest";
import { backoffSeconds } from "@/modules/jobs/queue";

describe("backoffSeconds", () => {
  it("grows exponentially and caps at 10 minutes", () => {
    const mid = () => 0.5; // jitter factor 1.0
    expect(backoffSeconds(1, mid)).toBe(5);
    expect(backoffSeconds(2, mid)).toBe(10);
    expect(backoffSeconds(3, mid)).toBe(20);
    expect(backoffSeconds(20, mid)).toBe(600);
  });

  it("applies ±20% jitter", () => {
    expect(backoffSeconds(1, () => 0)).toBe(4);
    expect(backoffSeconds(1, () => 1)).toBe(6);
  });
});
