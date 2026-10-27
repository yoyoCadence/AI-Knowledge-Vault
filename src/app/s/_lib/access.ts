import { getEnv } from "@/infrastructure/config/env";
import { getDb } from "@/infrastructure/database/client";
import { getLogger } from "@/infrastructure/observability/logger";
import { newErrorId } from "@/lib/ids";
import { rateLimitAddress } from "@/modules/auth";
import {
  resolveShare,
  SHARE_RATE_LIMIT,
  withinRateLimit,
  type ShareCapability,
} from "@/modules/sharing";

/**
 * The entry point of every share-link request, page or file (docs/SECURITY.md §7). The request
 * is counted against the client's address first, so unknown tokens cost the same as valid ones,
 * then the token is resolved to a narrow capability. No session is read: a link works the same
 * signed in or not, and never acts as the person who created it.
 *
 * Addresses come from X-Forwarded-For, trusted as for sign-in rate limits (DEPLOYMENT.md §5.6):
 * through TRUSTED_PROXIES, or a single-hop header that the edge proxy must overwrite. Exposed
 * without such a proxy, a client could choose its own address and evade or misdirect the
 * limit. Requests with no usable address share one "unknown" budget. IPv6 counts by /64.
 */
export type ShareAccess =
  { ok: true; capability: ShareCapability } | { ok: false; reason: "rate_limited" | "not_found" };

export async function accessShare(headers: Headers, token: string): Promise<ShareAccess> {
  const address = rateLimitAddress(headers, getEnv().TRUSTED_PROXIES) ?? "unknown";
  const allowed = await withinRateLimit(
    getDb(),
    `share:${address}`,
    SHARE_RATE_LIMIT.limit,
    SHARE_RATE_LIMIT.windowSeconds,
  );
  if (!allowed) return { ok: false, reason: "rate_limited" };
  const capability = await resolveShare(getDb(), token);
  return capability ? { ok: true, capability } : { ok: false, reason: "not_found" };
}

/** Never cached, never indexed, and the token in the URL is never sent on as a referrer. */
export const SHARE_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
  "x-content-type-options": "nosniff",
};

/** Every refusal is the same bare 404 (or 429), so a holder learns nothing about why. */
export function refusal(reason: "rate_limited" | "not_found"): Response {
  const headers = { ...SHARE_RESPONSE_HEADERS, "content-type": "text/plain; charset=utf-8" };
  return reason === "rate_limited"
    ? new Response("Too many requests", {
        status: 429,
        headers: { ...headers, "retry-after": String(SHARE_RATE_LIMIT.windowSeconds) },
      })
    : new Response("Not found", { status: 404, headers });
}

/**
 * A share-link route handler: the token is resolved before the handler runs, and errors become
 * a 500 with an error id (logged, never echoed).
 */
export function shareRoute(
  handler: (args: {
    request: Request;
    token: string;
    capability: ShareCapability;
  }) => Promise<Response>,
) {
  return async (request: Request, context: { params: Promise<{ token: string }> }) => {
    try {
      const { token } = await context.params;
      const access = await accessShare(request.headers, token);
      if (!access.ok) return refusal(access.reason);
      return await handler({ request, token, capability: access.capability });
    } catch (error) {
      const errorId = newErrorId();
      getLogger({ route: "/s" }).error({ err: error, errorId }, "share request failed");
      return new Response(`Internal error (${errorId})`, {
        status: 500,
        headers: { ...SHARE_RESPONSE_HEADERS, "content-type": "text/plain; charset=utf-8" },
      });
    }
  };
}
