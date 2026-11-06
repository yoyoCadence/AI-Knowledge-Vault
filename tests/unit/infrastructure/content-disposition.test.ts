import { describe, expect, it } from "vitest";
import { contentDisposition } from "@/infrastructure/storage";

/**
 * Downloads name their file through `filename*` (RFC 6266, RFC 8187). Its value may hold only
 * attr-chars; anything else must be percent-encoded. Chromium drops a `filename*` that holds a
 * raw apostrophe and falls back to the ASCII `filename`, where every non-ASCII character is `_`:
 * "報告's.md" was saved as "__'s.md".
 */
const ATTR_CHAR = /^[A-Za-z0-9!#$&+\-.^_`|~%]*$/;

function extValue(header: string): string {
  const match = /; filename\*=UTF-8''(.*)$/.exec(header);
  if (!match) throw new Error(`no filename* in ${header}`);
  return match[1]!;
}

function asciiFallback(header: string): string {
  const match = /^attachment; filename="([^"]*)";/.exec(header);
  if (!match) throw new Error(`no filename in ${header}`);
  return match[1]!;
}

describe("contentDisposition", () => {
  const names = [
    "報告's (final).md",
    "it's.html",
    "a*b (1).pdf",
    "研究筆記 2026.txt",
    'quote"back\\slash.html',
    "emoji 🧪.html",
    "100% done; really.zip",
  ];

  it.each(names)("encodes %s with attr-chars only, decoding back to the exact name", (name) => {
    const value = extValue(contentDisposition(name));
    expect(value).toMatch(ATTR_CHAR);
    expect(decodeURIComponent(value)).toBe(name);
  });

  it.each(names)("gives %s a quoted ASCII fallback without quotes or backslashes", (name) => {
    expect(asciiFallback(contentDisposition(name))).toMatch(/^[\x20-\x21\x23-\x5b\x5d-\x7e]*$/);
  });

  it("keeps an ASCII name as its own fallback", () => {
    expect(asciiFallback(contentDisposition("it's (1).html"))).toBe("it's (1).html");
  });
});
