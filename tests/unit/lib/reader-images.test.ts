import { describe, expect, it } from "vitest";
import { DATA_IMAGE_MAX_LENGTH, type ReaderImages, readerImageSrc } from "@/lib/reader-images";

/**
 * Reading mode shows an image only when its bytes are already ours: a raster `data:` image in
 * the document, or a stored file of the document's own bundle, from the preview origin. Anything
 * else stays alt text: a remote image would tell its host who reads what.
 */

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const BASE = "http://127.0.0.1:3100/p/TOKEN/";
const bundle: ReaderImages = {
  previewBase: BASE,
  entryPath: "report/index.html",
  files: ["report/img/chart.png", "report/圖表 2.webp", "logo.svg"],
};

describe("readerImageSrc", () => {
  it("shows raster data: images, whitespace removed, and nothing else that is data:", () => {
    expect(readerImageSrc(`data:image/png;base64,${PNG}`)).toBe(`data:image/png;base64,${PNG}`);
    expect(readerImageSrc(`data:image/JPEG;base64,\n${PNG.slice(0, 20)}\n${PNG.slice(20)}`)).toBe(
      `data:image/JPEG;base64,${PNG}`,
    );
    for (const refused of [
      "data:image/svg+xml;base64,PHN2Zy8+", // SVG: left out
      "data:image/svg+xml,<svg onload=alert(1)>",
      "data:text/html;base64,PGI+eDwvYj4=",
      `data:image/png,${PNG}`, // not base64
      "data:image/png;base64,not*base64",
      `data:image/png;base64,${"A".repeat(DATA_IMAGE_MAX_LENGTH)}`,
    ]) {
      expect(readerImageSrc(refused, bundle), refused.slice(0, 40)).toBeNull();
    }
  });

  it("never loads anything from elsewhere", () => {
    for (const remote of [
      "https://tracker.example/pixel.png",
      "http://example.org/a.png",
      "//cdn.example/a.png",
      "HTTPS://example.org/a.png",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "blob:http://x/1",
      "\\\\server\\share\\a.png",
    ]) {
      expect(readerImageSrc(remote, bundle), remote).toBeNull();
    }
  });

  it("resolves a bundle's own files against the entry document's folder", () => {
    expect(readerImageSrc("img/chart.png", bundle)).toBe(`${BASE}report/img/chart.png`);
    expect(readerImageSrc("./img/chart.png?v=2#x", bundle)).toBe(`${BASE}report/img/chart.png`);
    expect(readerImageSrc("../report/img/chart.png", bundle)).toBe(`${BASE}report/img/chart.png`);
    // Root-relative means the bundle's root; `..` cannot climb above it.
    expect(readerImageSrc("/logo.svg", bundle)).toBe(`${BASE}logo.svg`);
    expect(readerImageSrc("../../../logo.svg", bundle)).toBe(`${BASE}logo.svg`);
    // Names are matched decoded, and sent encoded.
    expect(readerImageSrc("%E5%9C%96%E8%A1%A8%202.webp", bundle)).toBe(
      `${BASE}report/%E5%9C%96%E8%A1%A8%202.webp`,
    );
    expect(readerImageSrc("圖表 2.webp", bundle)).toBe(`${BASE}report/%E5%9C%96%E8%A1%A8%202.webp`);
  });

  it("shows only files the bundle holds, and only with a preview to serve them", () => {
    expect(readerImageSrc("img/missing.png", bundle)).toBeNull();
    expect(readerImageSrc("index.html", bundle)).toBeNull(); // not an image file of the list
    expect(readerImageSrc("img/%2E%2E%2Fsecret.png", bundle)).toBeNull();
    expect(readerImageSrc("img/a%2Fb.png", bundle)).toBeNull();
    expect(readerImageSrc("img/%ZZ.png", bundle)).toBeNull();
    expect(readerImageSrc("", bundle)).toBeNull();
    expect(readerImageSrc("img/chart.png", { ...bundle, previewBase: null })).toBeNull();
    expect(readerImageSrc("img/chart.png")).toBeNull();
    // A data: image needs no bundle.
    expect(readerImageSrc(`data:image/gif;base64,${PNG}`, null)).not.toBeNull();
  });
});
