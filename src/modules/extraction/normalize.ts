import { createHash } from "node:crypto";

/** Collapses runs of whitespace inside lines and limits blank lines, trimming the ends. */
export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v 　 ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Hash of normalized plain text, used for suspected-duplicate detection (FR-IMP-9) and AI caching.
 * Whitespace-insensitive and Unicode-normalized so trivial re-exports hash equal.
 */
export function contentHash(plainText: string): string {
  const canonical = plainText.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Stable, URL-safe anchor for a heading (unique within a document via the `used` set). */
export function headingAnchor(heading: string, used: Set<string>): string {
  const base =
    heading
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "section";
  let anchor = base;
  for (let suffix = 2; used.has(anchor); suffix += 1) anchor = `${base}-${suffix}`;
  used.add(anchor);
  return anchor;
}

/** Filename without directories and extensions (`.dc.html`, `.tar.gz` …), for titles and identity. */
export function filenameStem(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  return base.replace(/(\.(dc|tar))?\.[a-z0-9]{1,8}$/i, "").replace(/\.(dc|tar)$/i, "") || base;
}

/**
 * A work's summary when its file has no description: the first line of its text long enough to
 * say something (20 characters) that is not the title, cut at 280 characters.
 */
export function summaryFromText(plainText: string, title?: string | null): string | null {
  const lines = plainText.split("\n").map((line) => line.trim());
  const first = lines.find((line) => line.length >= 20 && line !== title);
  if (!first) return null;
  return first.length > 280 ? `${first.slice(0, 279)}…` : first;
}
