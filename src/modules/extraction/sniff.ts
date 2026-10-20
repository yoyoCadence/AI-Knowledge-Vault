/**
 * Content-type detection from bytes (docs/IMPORT_PIPELINE.md §2). Client-declared MIME types and
 * extensions are never trusted on their own: the magic bytes decide; the extension only
 * disambiguates between text formats (HTML vs Markdown vs plain text).
 */
export type DetectedFormat =
  "zip" | "pdf" | "png" | "jpeg" | "webp" | "gif" | "html" | "markdown" | "text" | "unknown";

export interface SniffResult {
  format: DetectedFormat;
  mimeType: string;
}

const MIME: Record<DetectedFormat, string> = {
  zip: "application/zip",
  pdf: "application/pdf",
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  html: "text/html",
  markdown: "text/markdown",
  text: "text/plain",
  unknown: "application/octet-stream",
};

const startsWith = (head: Uint8Array, bytes: number[], offset = 0) =>
  head.length >= offset + bytes.length &&
  bytes.every((byte, index) => head[offset + index] === byte);

/** Returns the lower-cased final extension(s), treating `.dc.html` style double extensions as `.html`. */
export function fileExtension(filename: string): string {
  const base = filename.toLowerCase().split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1) : "";
}

function looksLikeText(head: Uint8Array): boolean {
  if (head.length === 0) return true;
  // UTF-16 BOMs are text even though they contain NULs.
  if (startsWith(head, [0xff, 0xfe]) || startsWith(head, [0xfe, 0xff])) return true;
  let control = 0;
  for (const byte of head) {
    if (byte === 0) return false;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) control += 1;
  }
  return control / head.length < 0.02;
}

function looksLikeHtml(head: Uint8Array): boolean {
  // Decode leniently just for detection; strip BOM and leading whitespace/comments.
  const text = new TextDecoder("utf-8", { fatal: false })
    .decode(head.subarray(0, 2048))
    .replace(/^﻿/, "")
    .trimStart()
    .toLowerCase();
  return (
    text.startsWith("<!doctype html") ||
    text.startsWith("<html") ||
    text.startsWith("<head") ||
    (text.startsWith("<!--") && /<html[\s>]/.test(text))
  );
}

/**
 * @param head the first bytes of the file (≥ 4 KiB recommended)
 * @param filename used only to choose between text formats
 */
export function sniffFormat(head: Uint8Array, filename: string): SniffResult {
  const result = (format: DetectedFormat): SniffResult => ({ format, mimeType: MIME[format] });

  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06]))
    return result("zip");
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return result("pdf"); // %PDF-
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return result("png");
  if (startsWith(head, [0xff, 0xd8, 0xff])) return result("jpeg");
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8))
    return result("webp");
  if (startsWith(head, [0x47, 0x49, 0x46, 0x38])) return result("gif");

  if (!looksLikeText(head)) return result("unknown");
  const extension = fileExtension(filename);
  if (looksLikeHtml(head) || extension === "html" || extension === "htm") return result("html");
  if (extension === "md" || extension === "markdown") return result("markdown");
  if (extension === "txt" || extension === "text" || extension === "") return result("text");
  return result("unknown");
}

export const MIME_TYPES = MIME;
