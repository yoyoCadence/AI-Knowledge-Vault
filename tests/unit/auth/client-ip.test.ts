import { describe, expect, it } from "vitest";
import { rateLimitAddress, resolveClientIp } from "@/modules/auth/client-ip";

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

describe("rateLimitAddress", () => {
  it("counts an IPv6 client by its /64, so rotating addresses inside it does not help", () => {
    const a = rateLimitAddress(headers("2001:db8:1:2::1"), []);
    expect(a).not.toBeNull();
    expect(rateLimitAddress(headers("2001:db8:1:2:ffff:ffff:ffff:ffff"), [])).toBe(a);
    expect(rateLimitAddress(headers("2001:db8:1:3::1"), [])).not.toBe(a);
    // Audit records keep the exact address.
    expect(resolveClientIp(headers("2001:db8:1:2::1"), [])).not.toBe(
      resolveClientIp(headers("2001:db8:1:2::2"), []),
    );
  });

  it("keeps IPv4 addresses whole and trusts headers like resolveClientIp", () => {
    expect(rateLimitAddress(headers("203.0.113.7"), [])).toBe("203.0.113.7");
    expect(rateLimitAddress(headers("198.51.100.66, 203.0.113.7"), [])).toBeNull();
    expect(rateLimitAddress(headers(), [])).toBeNull();
  });
});
