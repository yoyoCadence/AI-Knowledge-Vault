import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { appContentSecurityPolicy, proxy } from "@/proxy";

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

describe("app-origin Content-Security-Policy (SECURITY.md §11)", () => {
  const policyOf = (response: Response) => response.headers.get("content-security-policy");
  const NONCE = /'nonce-([A-Za-z0-9+/]{24})'/;

  it("gives every app response a policy with a fresh nonce, passed on to the page", () => {
    const first = proxy(request(APP, "/", "vault.session_token=x"));
    const second = proxy(request(APP, "/", "vault.session_token=x"));
    const nonce = NONCE.exec(policyOf(first) ?? "")?.[1];
    expect(nonce).toBeDefined();
    expect(NONCE.exec(policyOf(second) ?? "")?.[1]).not.toBe(nonce);
    // Next.js reads the request's policy for the nonce of its own scripts; the root layout
    // reads x-nonce. Both reach the page as overridden request headers.
    expect(first.headers.get("x-middleware-request-content-security-policy")).toBe(policyOf(first));
    expect(first.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
    // API responses and the signed-out login page carry it too.
    expect(policyOf(proxy(request(APP, "/api/artifacts")))).toMatch(NONCE);
    expect(policyOf(proxy(request(APP, "/login")))).toMatch(NONCE);
  });

  it("overwrites an x-nonce the client sent", () => {
    const sent = new NextRequest(new URL("/", APP), {
      headers: { host: APP.host, cookie: "vault.session_token=x", "x-nonce": "chosen" },
    });
    const response = proxy(sent);
    expect(response.headers.get("x-middleware-request-x-nonce")).not.toBe("chosen");
    expect(policyOf(response)).not.toContain("chosen");
  });

  it("never sets the app policy on the preview host", () => {
    const preview = proxy(request(PREVIEW, "/p/token/index.html"));
    expect(passes(preview)).toBe(true);
    expect(policyOf(preview)).toBeNull();
    expect(preview.headers.get("x-middleware-request-x-nonce")).toBeNull();
  });

  it("allows only nonced scripts and what they load; eval only in development", () => {
    const production = appContentSecurityPolicy("N", false);
    expect(production.split("; ")).toEqual([
      "script-src 'self' 'nonce-N' 'strict-dynamic'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ]);
    expect(production).not.toMatch(/unsafe-inline|unsafe-eval|default-src/);
    expect(appContentSecurityPolicy("N", true)).toContain(
      "script-src 'self' 'nonce-N' 'strict-dynamic' 'unsafe-eval'",
    );
  });
});
