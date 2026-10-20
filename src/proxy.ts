import { NextResponse, type NextRequest } from "next/server";

/**
 * Edge-of-app routing (runs before every route):
 *
 * 1. Origin isolation (ADR-007, docs/SECURITY.md §5): on the PREVIEW host only `/p/*` is served;
 *    on the APP host `/p/*` is refused, so untrusted content never shares the app origin.
 * 2. Optimistic auth redirect: page requests without a session cookie go to /login. This is a UX
 *    shortcut only — every page and API still verifies the session server-side (FR-AUTH-5).
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
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
