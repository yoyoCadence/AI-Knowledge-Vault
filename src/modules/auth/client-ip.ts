import { getIPFromHeader } from "@better-auth/core/utils/ip";

/**
 * Client IP for audit records (docs/SECURITY.md §6). Uses Better Auth's resolver, the one the
 * rate limiter uses: with TRUSTED_PROXIES configured it walks X-Forwarded-For right to left
 * past trusted hops, so a client-supplied leftmost entry is never recorded as the address.
 * Without trusted proxies only a single-hop header is believed. Returns null when no
 * trustworthy address exists; audit rows then say "unknown" rather than something forged.
 */
export function resolveClientIp(headers: Headers, trustedProxies: string[]): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (!forwarded) return null;
  return getIPFromHeader(forwarded, { trustedProxies, ipv6Subnet: 128 });
}

/**
 * The client address a rate limit counts against: as `resolveClientIp`, but an IPv6 address
 * stands for its /64, which one client usually holds whole (Better Auth's limiter does the same).
 * Keyed by /128, a client could rotate through its /64 and never be limited.
 */
export function rateLimitAddress(headers: Headers, trustedProxies: string[]): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (!forwarded) return null;
  return getIPFromHeader(forwarded, { trustedProxies, ipv6Subnet: 64 });
}
