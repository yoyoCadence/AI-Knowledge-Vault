import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "@/proxy";

const APP = new URL(process.env.APP_ORIGIN!);
const PREVIEW = new URL(process.env.PREVIEW_ORIGIN!);

function request(origin: URL, path: string, cookie?: string) {
  const headers = new Headers({ host: origin.host });
  if (cookie) headers.set("cookie", cookie);
  return new NextRequest(new URL(path, origin), { headers });
}

const passes = (response: Response) => response.headers.get("x-middleware-next") === "1";

describe("proxy origin isolation (SECURITY.md §5.2)", () => {
  it("serves only /p/* on the preview host", () => {
    expect(passes(proxy(request(PREVIEW, "/p/token/index.html")))).toBe(true);
    // Malformed percent-encoding would otherwise reach the router and become a generic 500.
    expect(proxy(request(PREVIEW, "/p/token/%E0%A4%A")).status).toBe(404);
    for (const path of ["/", "/login", "/api/artifacts", "/api/auth/get-session", "/import"]) {
      expect(proxy(request(PREVIEW, path)).status, path).toBe(404);
    }
  });

  it("refuses /p/* on the app host, signed in or not", () => {
    expect(proxy(request(APP, "/p/token/index.html")).status).toBe(404);
    expect(proxy(request(APP, "/p/token/index.html", "vault.session_token=x")).status).toBe(404);
    expect(proxy(request(APP, "/p")).status).toBe(404);
  });

  it("lets app routes through, redirecting signed-out page views to /login", () => {
    expect(passes(proxy(request(APP, "/api/artifacts")))).toBe(true);
    expect(passes(proxy(request(APP, "/import", "vault.session_token=x")))).toBe(true);
    const redirect = proxy(request(APP, "/import"));
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("location")).toBe(`${APP.origin}/login?next=%2Fimport`);
  });
});
