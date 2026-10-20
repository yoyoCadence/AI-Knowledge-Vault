import sharp from "sharp";

/**
 * Synthetic, public test fixtures (TEST_PLAN §1). Nothing here is real research or private data.
 * Binary fixtures are generated in code so the repository holds no opaque blobs.
 */

/** A plain HTML research note in Traditional Chinese. */
export function htmlDocument(
  options: { title?: string; body?: string; lang?: string } = {},
): string {
  const title = options.title ?? "形態發生研究筆記";
  return `<!DOCTYPE html>
<html lang="${options.lang ?? "zh-Hant-TW"}">
<head>
<meta charset="utf-8">
<title>${title}</title>
<meta name="description" content="胚胎發育中的圖案形成機制摘要。">
<style>body{font-family:serif}</style>
<script>window.tracking = "should never be extracted";</script>
</head>
<body>
<h1>${title}</h1>
${
  options.body ??
  `<p>胚胎沒有藍圖，只有規則。這份筆記整理形態發生的主要機制與證據強度。</p>
<h2>位置資訊</h2>
<p>細胞透過形態素濃度梯度得知自己的位置（positional information）。</p>
<ul><li>Bicoid 梯度</li><li>Sonic hedgehog</li></ul>
<h2>自組織</h2>
<p>Turing 反應擴散模型說明圖案可以在沒有地圖的情況下自行形成。</p>
<table><tr><th>機制</th><th>證據</th></tr><tr><td>梯度</td><td>強</td></tr></table>
<h2>來源</h2>
<ul><li><a href="https://doi.org/10.1098/rstb.1952.0012">Turing 1952</a></li><li><a href="https://example.org/paper">Example paper</a></li></ul>`
}
<div hidden>隱藏內容不應出現</div>
<button onclick="alert(1)">不應出現的按鈕</button>
</body>
</html>`;
}

/**
 * Mimics the structure of a Claude Design ("dc") export document: <x-dc>, <helmet> includes,
 * {{ bindings }}, <sc-if> and a text/x-dc component script (ARCHITECTURE_REVIEW F-03).
 */
export function claudeDesignDocument(title = "胚胎沒有藍圖，只有規則"): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<link rel="stylesheet" href="_ds/modernist/styles.css">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC">
<style>body{margin:0}</style>
</helmet>
<main>
<header><h1>${title}</h1><p>一顆受精卵如何「知道」要長出頭、手和眼睛？</p></header>
<section><h2>30 秒答案</h2><p>形態發生依靠局部規則與訊號梯度。</p></section>
<sc-if value="{{ show2 }}"><section><h2>劑量實驗</h2><p>目前劑量：{{ doseLabel }}</p></section></sc-if>
<section><h2>來源</h2><p><a href="https://doi.org/10.1126/science.1252960">Science 2014</a></p></section>
</main>
</x-dc>
<script type="text/x-dc" data-dc-script>class Component extends DCLogic { renderVals() { return {}; } }</script>
</body>
</html>`;
}

export function markdownDocument(): string {
  return `---
title: 量化交易研究摘要
date: 2026-09-01
model: example-model-1
author: Test Author
---

# 量化交易研究摘要

本文整理動能策略的證據。

## 動能效應

過去報酬較高的資產，短期內傾向持續表現。

## 參考資料

- [Jegadeesh 1993](https://doi.org/10.1111/j.1540-6261.1993.tb04702.x)
`;
}

/** "中文測試" encoded as Big5 (legacy Traditional Chinese encoding). */
export const BIG5_SAMPLE = Buffer.from([0xa4, 0xa4, 0xa4, 0xe5, 0xb4, 0xfa, 0xb8, 0xd5]);

/** Builds a minimal, valid multi-page PDF with a text layer (Helvetica, ASCII only). */
export function pdfDocument(
  pages: string[] = ["Hello Vault PDF page one", "Second page about morphogenesis"],
  title = "Vault Test PDF",
): Buffer {
  const objects: string[] = [];
  const pageIds: number[] = [];
  const fontId = 3 + pages.length * 2;
  pages.forEach((text, index) => {
    const pageId = 3 + index * 2;
    const contentId = pageId + 1;
    pageIds.push(pageId);
    const escaped = text.replace(/[()\\]/g, (char) => `\\${char}`);
    const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`;
    objects[contentId] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[fontId] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  const infoId = fontId + 1;
  objects[infoId] = `<< /Title (${title}) /Author (Fixture Builder) >>`;

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(body);
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1)
    body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

export async function pngImage(
  width = 320,
  height = 200,
  color = { r: 40, g: 90, b: 160 },
): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } })
    .png()
    .toBuffer();
}

/**
 * A Claude-Design-like export archive: <name>.dc.html + support.js + _ds/ design system +
 * .thumbnail (WebP). Mirrors the layout analysed in ARCHITECTURE_REVIEW F-03; content synthetic.
 */
export async function claudeDesignZipEntries(title = "胚胎沒有藍圖，只有規則") {
  const thumbnail = await sharp({
    create: { width: 160, height: 100, channels: 3, background: { r: 200, g: 120, b: 60 } },
  })
    .webp()
    .toBuffer();
  return [
    { name: ".thumbnail", data: thumbnail },
    {
      name: "Morphogenesis Report.dc.html",
      data: claudeDesignDocument(title),
      method: "deflate" as const,
    },
    { name: "_ds/modernist/_ds_bundle.js", data: "(() => { window.Modernist = {}; })();" },
    {
      name: "_ds/modernist/styles.css",
      data: ":root{--color-bg:#fff}body{margin:0}",
      method: "deflate" as const,
    },
    { name: "_ds/modernist/readme.md", data: "# Design system\n" },
    { name: "_ds/modernist/_adherence.oxlintrc.json", data: "{}" },
    {
      name: "support.js",
      data: "/* runtime that would load React from a CDN */",
      method: "deflate" as const,
    },
  ];
}
