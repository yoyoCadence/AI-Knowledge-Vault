import { NextResponse, type NextRequest } from "next/server";

/**
 * Host-based routing for origin isolation (ADR-007, docs/SECURITY.md §5).
 *
 * - On the PREVIEW host only `/p/*` (untrusted preview content) is served.
 * - On the APP host `/p/*` is refused, so untrusted content can never share the app origin.
 *
 * Reads env directly (no shared modules), per Next.js proxy guidance.
 */
function hostOf(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

export function proxy(request: NextRequest) {
  const previewHost = hostOf(process.env.PREVIEW_ORIGIN);
  const host = request.headers.get("host");
  const isPreviewPath =
    request.nextUrl.pathname === "/p" || request.nextUrl.pathname.startsWith("/p/");

  if (previewHost && host === previewHost) {
    if (!isPreviewPath) return new NextResponse(null, { status: 404 });
    return NextResponse.next();
  }
  if (isPreviewPath) return new NextResponse(null, { status: 404 });
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
