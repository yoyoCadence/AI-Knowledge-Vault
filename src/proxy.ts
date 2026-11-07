import { NextResponse, type NextRequest } from "next/server";

/**
 * Edge-of-app routing (runs before every route):
 *
 * 1. Origin isolation (ADR-007, docs/SECURITY.md §5): on the PREVIEW host only `/p/*` is served;
 *    on the APP host `/p/*` is refused, so untrusted content never shares the app origin.
 * 2. Optimistic auth redirect: page requests without a session cookie go to /login. This is a UX
 *    shortcut only — every page and API still verifies the session server-side (FR-AUTH-5).
 * 3. Content-Security-Policy for the app host (docs/SECURITY.md §11): a fresh nonce per request,
 *    which Next.js puts on its own scripts and the root layout hands to next-themes.
 *
 * Reads env directly (no shared modules), per Next.js proxy guidance.
 */
const SESSION_COOKIES = ["vault.session_token", "__Secure-vault.session_token"];
const PUBLIC_PAGE_PREFIXES = ["/login", "/s/"];

function hostOf(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

function decodable(pathname: string): boolean {
  try {
    decodeURIComponent(pathname);
    return true;
  } catch {
    return false;
  }
}

/**
 * The app origin's CSP. Scripts run only with this request's nonce, or when such a script loads
 * them ('strict-dynamic'), so injected markup can never run script: no inline handlers, no
 * `javascript:` URLs, no foreign script hosts. Plugins, `<base>` hijacking, forms posting
 * elsewhere and framing are refused too.
 *
 * Deliberately left unset, with no `default-src`, so they stay unrestricted:
 * - connect-src: browser uploads go straight to object storage (R2 or a local endpoint);
 * - frame-src: the preview iframe;
 * - img-src: reader images come from the preview origin;
 * - style-src: inline styles.
 * They hold no script, and the app renders no raw HTML (SECURITY.md §11).
 *
 * `next dev` needs 'unsafe-eval' (React rebuilds server error stacks with eval); production does
 * not. The preview host never gets this policy: its route sets a stricter one, and
 * `frame-ancestors 'none'` would stop the app from framing it.
 */
export function appContentSecurityPolicy(nonce: string, development: boolean): string {
  return [
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** 144 random bits, base64: unguessable, and fresh for every request. */
function newNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64");
}

/**
 * Lets the request through with this request's CSP. Next.js reads the request's
 * `Content-Security-Policy` header for the nonce to put on its scripts. `x-nonce` hands it to
 * the root layout; any value a client sent is overwritten here.
 */
function nextWithCsp(request: NextRequest): NextResponse {
  const nonce = newNonce();
  const policy = appContentSecurityPolicy(nonce, process.env.NODE_ENV === "development");
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("content-security-policy", policy);
  return response;
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const previewHost = hostOf(process.env.PREVIEW_ORIGIN);
  const host = request.headers.get("host");
  const isPreviewPath = pathname === "/p" || pathname.startsWith("/p/");

  if (previewHost && host === previewHost) {
    // Malformed percent-encoding is refused here like any other bad preview path, before the
    // router can turn it into a generic error page on the preview origin.
    return isPreviewPath && decodable(pathname)
      ? NextResponse.next()
      : new NextResponse(null, { status: 404 });
  }
  if (isPreviewPath) return new NextResponse(null, { status: 404 });

  const isApi = pathname.startsWith("/api/");
  const isPublicPage = PUBLIC_PAGE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix),
  );
  if (!isApi && !isPublicPage) {
    const hasSessionCookie = SESSION_COOKIES.some((name) => request.cookies.has(name));
    if (!hasSessionCookie) {
      const login = new URL("/login", request.url);
      if (pathname !== "/") login.searchParams.set("next", `${pathname}${search}`);
      return NextResponse.redirect(login);
    }
  }
  return nextWithCsp(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
