import { describe, expect, it } from "vitest";
import { newId } from "@/lib/ids";
import { signToken } from "@/lib/signed-token";
import {
  OWNER_PREVIEW_TTL_SECONDS,
  createPreviewToken,
  normalizePreviewPath,
  previewContentType,
  previewHeaders,
  verifyPreviewToken,
} from "@/modules/preview";

const SECRET = "unit-preview-secret-0123456789abcdef0123456789";
const NOW = new Date("2026-10-20T10:00:00Z");

describe("preview tokens (SECURITY.md §5.3)", () => {
  const target = { versionId: newId(), workspaceId: newId() };

  it("round-trips the bound version and workspace, expiring after 15 minutes", () => {
    const { token, expiresAt } = createPreviewToken(SECRET, target, NOW);
    expect(expiresAt.getTime() - NOW.getTime()).toBe(OWNER_PREVIEW_TTL_SECONDS * 1000);
    expect(token).toMatch(/^[\w-]+\.[\w-]+$/); // path-safe: base64url and one dot
    expect(verifyPreviewToken(SECRET, token, NOW)).toMatchObject({
      v: target.versionId,
      w: target.workspaceId,
      s: "owner",
    });
    expect(verifyPreviewToken(SECRET, token, expiresAt)).toBeNull();
  });

  it("rejects tampered, foreign-secret, wrong-purpose and malformed tokens", () => {
    const { token } = createPreviewToken(SECRET, target, NOW);
    const [body, mac] = token.split(".") as [string, string];
    const other = createPreviewToken(SECRET, { ...target, versionId: newId() }, NOW).token;
    const otherBody = other.split(".")[0]!;
    expect(verifyPreviewToken(SECRET, `${otherBody}.${mac}`, NOW)).toBeNull();
    expect(verifyPreviewToken(`${SECRET}x`, token, NOW)).toBeNull();
    expect(verifyPreviewToken(SECRET, `${body}.`, NOW)).toBeNull();
    expect(verifyPreviewToken(SECRET, "not-a-token", NOW)).toBeNull();
    const exp = Math.floor(NOW.getTime() / 1000) + 60;
    const storageToken = signToken(SECRET, { purpose: "storage", exp, v: target.versionId });
    expect(verifyPreviewToken(SECRET, storageToken, NOW)).toBeNull();
  });

  it("binds a share-scoped token to its link", () => {
    const linkId = newId();
    const { token } = createPreviewToken(SECRET, { ...target, shareLinkId: linkId }, NOW, 60);
    expect(verifyPreviewToken(SECRET, token, NOW)).toMatchObject({ s: "share", l: linkId });
    const owner = createPreviewToken(SECRET, target, NOW).token;
    expect(verifyPreviewToken(SECRET, owner, NOW)).toMatchObject({ s: "owner" });
    expect(verifyPreviewToken(SECRET, owner, NOW)).not.toHaveProperty("l");
  });

  it("rejects well-signed tokens with unexpected claims", () => {
    const exp = Math.floor(NOW.getTime() / 1000) + 60;
    const sign = (claims: Record<string, unknown>) =>
      signToken(SECRET, { purpose: "preview", exp, ...claims });
    const { versionId: v, workspaceId: w } = target;
    const l = newId();
    expect(verifyPreviewToken(SECRET, sign({ v, w, s: "owner" }), NOW)).not.toBeNull();
    expect(verifyPreviewToken(SECRET, sign({ v, w, s: "share", l }), NOW)).not.toBeNull();
    // A share token names its link; an owner token names none; nothing else is a scope.
    expect(verifyPreviewToken(SECRET, sign({ v, w, s: "share" }), NOW)).toBeNull();
    expect(verifyPreviewToken(SECRET, sign({ v, w, s: "share", l: "x" }), NOW)).toBeNull();
    expect(verifyPreviewToken(SECRET, sign({ v, w, s: "owner", l }), NOW)).toBeNull();
    expect(verifyPreviewToken(SECRET, sign({ v, w, s: "public", l }), NOW)).toBeNull();
    expect(verifyPreviewToken(SECRET, sign({ v: "../x", w, s: "owner" }), NOW)).toBeNull();
    expect(verifyPreviewToken(SECRET, sign({ v, w: 42, s: "owner" }), NOW)).toBeNull();
  });
});

describe("normalizePreviewPath (SECURITY.md §5.6)", () => {
  it("decodes each raw segment exactly once and NFC-normalizes", () => {
    expect(normalizePreviewPath(["index.html"])).toBe("index.html");
    expect(normalizePreviewPath(["_ds", "modernist", "styles.css"])).toBe(
      "_ds/modernist/styles.css",
    );
    expect(normalizePreviewPath(["Urban%20Heat%20Report.dc.html"])).toBe(
      "Urban Heat Report.dc.html",
    );
    expect(normalizePreviewPath([encodeURIComponent("研究報告.html")])).toBe("研究報告.html");
    // NFD "é" (e + combining acute) is looked up as its NFC form.
    expect(normalizePreviewPath([encodeURIComponent("café.html")])).toBe("café.html");
    // A literal "%" in a filename survives a single decode; it is not decoded twice.
    expect(normalizePreviewPath(["100%2525.html"])).toBe("100%25.html");
  });

  it.each([
    [[]],
    [[""]],
    [["a", "", "b"]],
    [["."]],
    [[".."]],
    [["a", "..", "b"]],
    [["%2e%2e"]],
    [["..%2Fsecret"]],
    [["a%2Fb"]],
    [["a%5Cb"]],
    [["a%00.html"]],
    [["a%0A.html"]],
    [["a%7F.html"]],
    [["%E0%A4%A"]],
    [Array.from({ length: 33 }, () => "a")],
    [["a".repeat(1025)]],
  ])("refuses %j", (segments) => {
    expect(normalizePreviewPath(segments)).toBeNull();
  });
});

describe("preview response headers (SECURITY.md §5.4, §5.7)", () => {
  it("serves scripts as plain text and declares no charset (documents may be Big5)", () => {
    expect(previewContentType("support.js")).toBe("text/plain");
    expect(previewContentType("bundle.mjs")).toBe("text/plain");
    expect(previewContentType("index.html")).toBe("text/html");
    expect(previewContentType("a/styles.css")).toBe("text/css");
    expect(previewContentType("logo.svg")).toBe("image/svg+xml");
    expect(previewContentType("photo.PNG")).toBe("image/png");
  });

  it("emits the documented CSP, sandboxing everything but PDFs", () => {
    const origins = { appOrigin: "https://app.test", previewOrigin: "https://preview.test" };
    const html = previewHeaders({ ...origins, contentType: "text/html; charset=utf-8" });
    const csp = html["content-security-policy"]!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("style-src https://preview.test 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors https://app.test");
    expect(csp).toMatch(/; sandbox allow-same-origin$/);
    expect(html).toMatchObject({
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cross-origin-resource-policy": "cross-origin",
      "cache-control": "private, max-age=300",
    });
    const pdf = previewHeaders({ ...origins, contentType: "application/pdf" });
    expect(pdf["content-security-policy"]).not.toContain("sandbox");
    expect(pdf["content-security-policy"]).toContain("script-src 'none'");
  });
});
