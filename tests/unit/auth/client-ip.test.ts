import { describe, expect, it } from "vitest";
import { resolveClientIp } from "@/modules/auth/client-ip";

const headers = (forwarded?: string) =>
  new Headers(forwarded ? { "x-forwarded-for": forwarded } : {});

describe("resolveClientIp", () => {
  it("believes a single-hop header when no proxies are trusted", () => {
    expect(resolveClientIp(headers("203.0.113.7"), [])).toBe("203.0.113.7");
    expect(resolveClientIp(headers(), [])).toBeNull();
  });

  it("refuses a multi-hop header without trusted proxies instead of trusting the leftmost entry", () => {
    expect(resolveClientIp(headers("198.51.100.66, 203.0.113.7"), [])).toBeNull();
  });

  it("walks past trusted proxies from the right, ignoring a forged leftmost entry", () => {
    expect(resolveClientIp(headers("198.51.100.66, 203.0.113.7, 10.0.0.5"), ["10.0.0.0/8"])).toBe(
      "203.0.113.7",
    );
  });

  it("rejects garbage", () => {
    expect(resolveClientIp(headers("not-an-ip"), [])).toBeNull();
  });
});
