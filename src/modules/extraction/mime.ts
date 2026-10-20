/**
 * Our own extension → MIME map for derived preview files (SECURITY.md §5: never trust uploaded
 * content types). The preview server applies additional serving rules (e.g. scripts as text).
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  txt: "text/plain",
  md: "text/markdown",
  pdf: "application/pdf",
};

export function mimeForPath(path: string): string {
  const base = path.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  const extension = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}
