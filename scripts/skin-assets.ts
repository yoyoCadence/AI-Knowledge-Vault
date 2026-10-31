/**
 * Generates the assets of the "archive" skin (docs/THEME.md) into
 * src/app/_skins/archive/assets/:
 *
 *   pnpm tsx scripts/skin-assets.ts
 *
 * Nothing here is drawn by an image model: the textures are seeded noise and the scenery is
 * composed from simple shapes. Every random choice comes from a fixed seed, so a rerun writes
 * the same files; change a parameter here and rerun to change an asset.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const OUT = path.join(process.cwd(), "src/app/_skins/archive/assets");

type Rgb = [number, number, number];
type Random = () => number;

/** mulberry32: a small seeded PRNG. */
function seeded(seed: number): Random {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Value noise on a lattice that wraps, so a texture made from it tiles. u and v are in [0, 1). */
function periodicNoise(cellsX: number, cellsY: number, random: Random) {
  const grid = Array.from({ length: cellsX * cellsY }, random);
  const wrap = (n: number, size: number) => ((n % size) + size) % size;
  const at = (i: number, j: number) => grid[wrap(j, cellsY) * cellsX + wrap(i, cellsX)]!;
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (u: number, v: number) => {
    const x = u * cellsX;
    const y = v * cellsY;
    const i = Math.floor(x);
    const j = Math.floor(y);
    const fx = smooth(x - i);
    const fy = smooth(y - j);
    const top = at(i, j) + (at(i + 1, j) - at(i, j)) * fx;
    const bottom = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * fx;
    return top + (bottom - top) * fy;
  };
}

const clamp = (value: number) => Math.min(1, Math.max(0, value));

/**
 * Paper fibre and mottling, as a transparent tile laid over a surface colour, so one texture
 * serves every paper tone. `strength` scales the alpha (light paper takes more than dark).
 */
async function paperGrain(file: string, color: Rgb, strength: number, seed: number) {
  const size = 256;
  const random = seeded(seed);
  const octaves = [4, 8, 16, 32].map((cells) => periodicNoise(cells, cells, random));
  const alpha = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const mottle =
        octaves.reduce((sum, noise, k) => sum + noise(x / size, y / size) / 2 ** k, 0) / 1.875;
      alpha[y * size + x] = Math.max(0, mottle - 0.5) * 0.3 + random() * 0.05;
    }
  }
  for (let fibre = 0; fibre < 90; fibre++) {
    let x = random() * size;
    let y = random() * size;
    let angle = random() * Math.PI * 2;
    const length = 6 + random() * 26;
    const opacity = 0.08 + random() * 0.1;
    for (let step = 0; step < length; step += 0.5) {
      angle += (random() - 0.5) * 0.15;
      x += Math.cos(angle) * 0.5;
      y += Math.sin(angle) * 0.5;
      const index =
        (((Math.round(y) % size) + size) % size) * size + (((Math.round(x) % size) + size) % size);
      alpha[index] = Math.max(alpha[index]!, opacity);
    }
  }
  const data = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = color[0];
    data[i * 4 + 1] = color[1];
    data[i * 4 + 2] = color[2];
    data[i * 4 + 3] = Math.round(clamp(alpha[i]!) * 255 * strength);
  }
  await sharp(data, { raw: { width: size, height: size, channels: 4 } })
    .webp({ quality: 80, alphaQuality: 80 })
    .toFile(path.join(OUT, file));
}

/** Walnut with vertical grain for the catalogue cabinet (the sidebar); tiles both ways. */
async function walnut(file: string, seed: number) {
  const width = 256;
  const height = 512;
  const random = seeded(seed);
  const warp = periodicNoise(3, 6, random);
  const warpFine = periodicNoise(8, 24, random);
  const streak = periodicNoise(64, 8, random);
  const dark: Rgb = [50, 32, 20];
  const light: Rgb = [101, 67, 42];
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const v = y / height;
      const bend = (warp(u, v) - 0.5) * 0.5 + (warpFine(u, v) - 0.5) * 0.1;
      // Seven grain cycles across the width: an integer, so the left and right edges meet.
      const rings = 0.5 + 0.5 * Math.sin(2 * Math.PI * (u * 7 + bend));
      const t = clamp(rings ** 2.2 * 0.55 + streak(u, v) * 0.35 + random() * 0.08);
      for (let c = 0; c < 3; c++) {
        data[(y * width + x) * 3 + c] = Math.round(dark[c]! + (light[c]! - dark[c]!) * t);
      }
    }
  }
  for (let pore = 0; pore < 900; pore++) {
    const x = Math.floor(random() * width);
    const y0 = Math.floor(random() * height);
    const length = 2 + Math.floor(random() * 5);
    for (let dy = 0; dy < length; dy++) {
      const index = (((y0 + dy) % height) * width + x) * 3;
      for (let c = 0; c < 3; c++) data[index + c] = Math.round(data[index + c]! * 0.8);
    }
  }
  await sharp(data, { raw: { width, height, channels: 3 } })
    .webp({ quality: 78 })
    .toFile(path.join(OUT, file));
}

// ---- Drawn scenery (SVG) ----

const n = (value: number) => Number(value.toFixed(1));
const SPINES = [
  "#7a2e24", // oxblood
  "#2f5745", // library green
  "#2a3c5c", // navy
  "#a8792c", // ochre
  "#5b3a5e", // plum
  "#cdb98e", // vellum
  "#3b3a36", // charcoal
  "#8c5a2b", // tan leather
];
const GILT = "#d6b06a";
const BRASS = "#b8914a";

function pick<T>(items: readonly T[], random: Random): T {
  return items[Math.floor(random() * items.length)]!;
}

/** One standing book, its spine facing out: gilt bands, sometimes a paper label. */
function spine(x: number, base: number, w: number, h: number, color: string, random: Random) {
  const top = base - h;
  const parts = [
    `<rect x="${n(x)}" y="${n(top)}" width="${n(w)}" height="${n(h)}" rx="1.2" fill="${color}"/>`,
    `<rect x="${n(x)}" y="${n(top)}" width="${n(Math.min(2, w / 5))}" height="${n(h)}" fill="#fff" opacity=".14"/>`,
    `<rect x="${n(x + w - 2)}" y="${n(top)}" width="2" height="${n(h)}" fill="#000" opacity=".22"/>`,
  ];
  for (const y of [top + 5 + random() * 4, base - 9 - random() * 4]) {
    parts.push(
      `<rect x="${n(x + 1)}" y="${n(y)}" width="${n(w - 2)}" height="1.6" fill="${GILT}" opacity=".75"/>`,
    );
  }
  if (w > 12 && random() < 0.5) {
    parts.push(
      `<rect x="${n(x + 2.5)}" y="${n(top + h * 0.3)}" width="${n(w - 5)}" height="${n(Math.min(14, h * 0.16))}" rx="1" fill="#efe2c4" opacity=".85"/>`,
    );
  }
  return parts.join("");
}

/** A run of standing books from x0 to x1, the last one leaning on its neighbour. */
function books(x0: number, x1: number, base: number, heights: [number, number], random: Random) {
  const parts: string[] = [];
  let x = x0;
  let previous = "";
  while (x < x1 - 10) {
    const w = 9 + random() * 13;
    const h = heights[0] + random() * (heights[1] - heights[0]);
    let color = pick(SPINES, random);
    if (color === previous) color = pick(SPINES, random);
    previous = color;
    parts.push(spine(x, base, w, h, color, random));
    x += w + 0.6;
  }
  const lean = 16 + random() * 8;
  const w = 12 + random() * 6;
  const h = heights[1] * 0.9;
  parts.push(
    `<g transform="rotate(${n(lean)} ${n(x)} ${n(base)})">${spine(x, base, w, h, pick(SPINES, random), random)}</g>`,
  );
  return parts.join("");
}

/** Books lying flat, page edges showing, largest at the bottom. */
function stack(x: number, base: number, count: number, random: Random) {
  const parts: string[] = [];
  let y = base;
  let w = 96;
  for (let i = 0; i < count; i++) {
    const h = 9 + random() * 6;
    const dx = x + (96 - w) / 2 + (random() - 0.5) * 6;
    y -= h;
    parts.push(
      `<rect x="${n(dx)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="1.5" fill="${pick(SPINES, random)}"/>`,
      `<rect x="${n(dx + w - 5)}" y="${n(y + 1.5)}" width="4" height="${n(h - 3)}" fill="#efe3c6"/>`,
      `<rect x="${n(dx + 6)}" y="${n(y + h / 2 - 0.8)}" width="${n(w * 0.4)}" height="1.6" fill="${GILT}" opacity=".7"/>`,
    );
    w -= 6 + random() * 6;
  }
  return parts.join("");
}

/** A leaf shape pointing up from the origin. */
const leaf = (length: number, width: number) =>
  `M0 0 C${n(width)} ${n(-length / 3)} ${n(width)} ${n((-2 * length) / 3)} 0 ${n(-length)} C${n(-width)} ${n((-2 * length) / 3)} ${n(-width)} ${n(-length / 3)} 0 0Z`;

function plant(cx: number, base: number, scale: number, random: Random) {
  const pot = 30 * scale;
  const top = base - pot;
  const leaves: string[] = [];
  const count = 11;
  for (let i = 0; i < count; i++) {
    const angle = -75 + (150 * i) / (count - 1) + (random() - 0.5) * 12;
    const length = (34 + random() * 30) * scale * (1 - Math.abs(angle) / 260);
    const fill = random() < 0.5 ? "#4f6b3a" : "#6a8a48";
    leaves.push(
      `<path d="${leaf(length, 6.5 * scale)}" fill="${fill}" transform="translate(${n(cx)} ${n(top + 2)}) rotate(${n(angle)})"/>`,
    );
  }
  return [
    ...leaves,
    `<path d="M${n(cx - 17 * scale)} ${n(base)} L${n(cx + 17 * scale)} ${n(base)} L${n(cx + 21 * scale)} ${n(top + 6 * scale)} L${n(cx - 21 * scale)} ${n(top + 6 * scale)}Z" fill="#a65a3a"/>`,
    `<rect x="${n(cx - 24 * scale)} " y="${n(top)}" width="${n(48 * scale)}" height="${n(7 * scale)}" rx="1.5" fill="#b8684a"/>`,
    `<rect x="${n(cx - 17 * scale)}" y="${n(base - 4)}" width="${n(34 * scale)}" height="2" fill="#000" opacity=".18"/>`,
  ].join("");
}

/** A banker's lamp with its pool of light. */
function lamp(cx: number, base: number) {
  const shade = base - 92;
  return [
    `<ellipse cx="${cx}" cy="${base - 30}" rx="120" ry="70" fill="url(#glow)"/>`,
    `<rect x="${cx - 2.5}" y="${shade + 14}" width="5" height="${base - shade - 20}" fill="${BRASS}"/>`,
    `<path d="M${cx - 44} ${shade + 18} C${cx - 42} ${shade - 6} ${cx + 42} ${shade - 6} ${cx + 44} ${shade + 18}Z" fill="#2f6b4f"/>`,
    `<path d="M${cx - 30} ${shade + 6} C${cx - 18} ${shade - 2} ${cx + 4} ${shade - 3} ${cx + 18} ${shade + 1}" stroke="#bfe0c9" stroke-opacity=".45" stroke-width="2.5" fill="none" stroke-linecap="round"/>`,
    `<rect x="${cx - 45}" y="${shade + 16}" width="90" height="4" rx="2" fill="${BRASS}"/>`,
    `<path d="M${cx - 26} ${base} C${cx - 26} ${base - 9} ${cx + 26} ${base - 9} ${cx + 26} ${base}Z" fill="${BRASS}"/>`,
    `<rect x="${cx - 28}" y="${base - 2}" width="56" height="3" rx="1.5" fill="#8d6a2c"/>`,
  ].join("");
}

function globe(cx: number, base: number) {
  const cy = base - 62;
  return [
    `<path d="M${cx - 16} ${base} L${cx + 16} ${base} L${cx + 6} ${base - 16} L${cx - 6} ${base - 16}Z" fill="#5a3a24"/>`,
    `<rect x="${cx - 2}" y="${cy + 30}" width="4" height="${base - cy - 44}" fill="${BRASS}"/>`,
    `<circle cx="${cx}" cy="${cy}" r="34" fill="#cdb98a"/>`,
    `<path d="M${cx - 22} ${cy - 14} c8 -6 18 -4 20 4 c2 8 -8 10 -6 18 c-6 4 -14 -2 -16 -10 c-1 -6 -2 -8 2 -12Z M${cx + 6} ${cy - 24} c10 2 16 10 14 18 c-6 6 -12 0 -16 -6 c-2 -6 -4 -10 2 -12Z M${cx + 4} ${cy + 8} c8 -2 14 4 12 12 c-4 6 -10 6 -14 0 c-2 -4 -2 -10 2 -12Z" fill="#7d8a5c"/>`,
    `<ellipse cx="${cx}" cy="${cy}" rx="14" ry="34" fill="none" stroke="#7a6340" stroke-opacity=".35"/>`,
    `<path d="M${cx - 34} ${cy} H${cx + 34}" stroke="#7a6340" stroke-opacity=".35"/>`,
    `<path d="M${cx - 38} ${cy + 14} A40 40 0 0 1 ${cx + 22} ${cy - 34}" fill="none" stroke="${BRASS}" stroke-width="3"/>`,
  ].join("");
}

/** Archive boxes with brass label holders and finger holes. */
function boxes(x: number, base: number, count: number) {
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    const bx = x + i * 62;
    const h = 74 - (i % 2) * 6;
    parts.push(
      `<rect x="${bx}" y="${base - h}" width="58" height="${h}" rx="1.5" fill="${i % 2 ? "#a88e63" : "#b79d73"}"/>`,
      `<rect x="${bx}" y="${base - h}" width="58" height="3" fill="#000" opacity=".12"/>`,
      `<rect x="${bx + 15}" y="${base - h + 14}" width="28" height="14" rx="1" fill="none" stroke="${BRASS}" stroke-width="2"/>`,
      `<rect x="${bx + 17}" y="${base - h + 16}" width="24" height="10" fill="#f1e6cc"/>`,
      `<path d="M${bx + 21} ${base - h + 21} h16" stroke="#7a6340" stroke-opacity=".5"/>`,
      `<ellipse cx="${bx + 29}" cy="${base - 18}" rx="9" ry="4" fill="#5a4630"/>`,
    );
  }
  return parts.join("");
}

function shelfBoard(width: number, y: number) {
  return [
    `<rect x="0" y="${y}" width="${width}" height="14" fill="#4a2f1e"/>`,
    `<rect x="0" y="${y}" width="${width}" height="2" fill="#7a5436"/>`,
    `<rect x="0" y="${y + 12}" width="${width}" height="2" fill="#2e1d12"/>`,
  ].join("");
}

const svg = (width: number, height: number, body: string, extra = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"${extra}>${body}</svg>\n`;

/** The bookshelf at the end of every page. Its middle (x 520–1080) is what a phone shows. */
function footerScene() {
  const random = seeded(20261031);
  const base = 146;
  const defs = `<defs><radialGradient id="glow"><stop offset="0" stop-color="#ffe3a0" stop-opacity=".55"/><stop offset="1" stop-color="#ffe3a0" stop-opacity="0"/></radialGradient></defs>`;
  return svg(
    1600,
    160,
    [
      defs,
      books(30, 290, base, [62, 104], random),
      boxes(318, base, 3),
      plant(548, base, 1, random),
      books(604, 812, base, [70, 112], random),
      lamp(884, base),
      stack(962, base, 6, random),
      globe(1132, base),
      books(1212, 1462, base, [58, 100], random),
      plant(1526, base, 0.75, random),
      shelfBoard(1600, base),
    ].join(""),
    ` preserveAspectRatio="xMidYMax slice"`,
  );
}

/** The shelf at the foot of the sidebar (the catalogue cabinet). */
function sidebarShelf() {
  const random = seeded(1987);
  const base = 106;
  const bookend = `<path d="M214 ${base} V${base - 46} h4 V${base - 4} h14 V${base}Z" fill="${BRASS}"/>`;
  return svg(
    240,
    120,
    [books(10, 186, base, [52, 90], random), bookend, shelfBoard(240, base)].join(""),
  );
}

/** A pressed sprig: decoration for the login card and empty drawers. */
function sprig() {
  const random = seeded(77);
  const parts: string[] = [];
  const point = (t: number) => {
    // Quadratic Bézier from (18,132) via (40,40) to (122,16).
    const x = (1 - t) ** 2 * 18 + 2 * (1 - t) * t * 40 + t * t * 122;
    const y = (1 - t) ** 2 * 132 + 2 * (1 - t) * t * 40 + t * t * 16;
    const dx = 2 * (1 - t) * (40 - 18) + 2 * t * (122 - 40);
    const dy = 2 * (1 - t) * (40 - 132) + 2 * t * (16 - 40);
    return { x, y, angle: (Math.atan2(dy, dx) * 180) / Math.PI + 90 };
  };
  parts.push(
    `<path d="M18 132 Q40 40 122 16" fill="none" stroke="#6b5a3a" stroke-width="1.8" stroke-linecap="round"/>`,
  );
  for (let i = 0; i < 9; i++) {
    const t = 0.1 + i * 0.1;
    const { x, y, angle } = point(t);
    const side = i % 2 ? 1 : -1;
    const length = 24 - i * 1.4;
    const fill = random() < 0.5 ? "#7b8a52" : "#8d9a5e";
    parts.push(
      `<g transform="translate(${n(x)} ${n(y)}) rotate(${n(angle + side * 55)})"><path d="${leaf(length, 5.5)}" fill="${fill}" opacity=".92"/><path d="M0 0 V${n(-length * 0.85)}" stroke="#5b6a3a" stroke-width=".8"/></g>`,
    );
  }
  for (const [x, y] of [
    [124, 14],
    [118, 22],
    [128, 24],
  ] as const) {
    parts.push(`<circle cx="${x}" cy="${y}" r="3.2" fill="#a3472f"/>`);
  }
  return svg(140, 140, parts.join(""));
}

/** The library's seal, stamped in red ink (a lighter red on dark paper). */
function seal(ink: string) {
  return svg(
    120,
    120,
    `<defs>
  <filter id="ink" x="-10%" y="-10%" width="120%" height="120%">
    <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" result="noise"/>
    <feColorMatrix in="noise" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -2 2.05" result="holes"/>
    <feComposite in="SourceGraphic" in2="holes" operator="in" result="speckled"/>
    <feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="2" seed="3" result="warp"/>
    <feDisplacementMap in="speckled" in2="warp" scale="2.5" xChannelSelector="R" yChannelSelector="G"/>
  </filter>
  <path id="ring" d="M60 60 m-40 0 a40 40 0 1 1 80 0 a40 40 0 1 1 -80 0"/>
</defs>
<g transform="rotate(-9 60 60)" filter="url(#ink)" opacity=".9">
  <g fill="none" stroke="${ink}">
    <circle cx="60" cy="60" r="55" stroke-width="4"/>
    <circle cx="60" cy="60" r="49" stroke-width="1.2"/>
    <circle cx="60" cy="60" r="30" stroke-width="1.2"/>
    <path d="M60 49 C53 44.5 45 44.5 39 46.5 V69 C45 67 53 67 60 71.5 C67 67 75 67 81 69 V46.5 C75 44.5 67 44.5 60 49 Z M60 49 V71.5" stroke-width="2.2" stroke-linejoin="round"/>
    <path d="M43.5 52 C48 51 52.5 51.5 56 53 M43.5 57 C48 56 52.5 56.5 56 58 M43.5 62 C48 61 52.5 61.5 56 63 M64 53 C67.5 51.5 72 51 76.5 52 M64 58 C67.5 56.5 72 56 76.5 57 M64 63 C67.5 61.5 72 61 76.5 62" stroke-width="1.2" stroke-linecap="round"/>
  </g>
  <path d="M60 34.5 l1.6 3.6 3.9 .4 -2.9 2.6 .9 3.8 -3.5 -2 -3.5 2 .9 -3.8 -2.9 -2.6 3.9 -.4Z" fill="${ink}"/>
  <text font-family="Georgia, 'Times New Roman', serif" font-size="8.6" letter-spacing="1.6" fill="${ink}"><textPath href="#ring" textLength="246">AI KNOWLEDGE VAULT · ARCHIVE ·</textPath></text>
</g>`,
  );
}

/** A brass photo-corner mount; `rotate` turns it for the other corners. */
function corner(rotate: number) {
  return svg(
    22,
    22,
    `<defs><linearGradient id="brass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f0d58f"/><stop offset=".55" stop-color="#c39a4c"/><stop offset="1" stop-color="#8d6a2c"/></linearGradient></defs>
<g transform="rotate(${rotate} 11 11)">
  <path d="M0 0 H22 L0 22 Z" fill="url(#brass)"/>
  <path d="M3 3 H15.5 L3 15.5 Z" fill="none" stroke="#fff4d0" stroke-opacity=".5" stroke-width=".8"/>
  <path d="M22 0 L0 22" stroke="#6b4f1f" stroke-opacity=".45"/>
  <circle cx="5.4" cy="5.4" r="1.4" fill="#7a5a22"/>
  <circle cx="5" cy="5" r=".55" fill="#fff3cf" opacity=".8"/>
</g>`,
  );
}

/** A diamond lattice with quatrefoils, the reading room's wallpaper. */
function wallpaper(color: string, lineOpacity: number, fillOpacity: number) {
  const quatrefoil = (x: number, y: number) =>
    [
      [0, -2.4],
      [2.4, 0],
      [0, 2.4],
      [-2.4, 0],
    ]
      .map(([dx, dy]) => `<circle cx="${n(x + dx!)}" cy="${n(y + dy!)}" r="2"/>`)
      .join("");
  return svg(
    64,
    64,
    `<path d="M0 32 L32 0 L64 32 L32 64 Z" fill="none" stroke="${color}" stroke-opacity="${lineOpacity}" stroke-width=".8"/>
<g fill="${color}" fill-opacity="${fillOpacity}">${quatrefoil(32, 32)}${quatrefoil(0, 0)}${quatrefoil(64, 0)}${quatrefoil(0, 64)}${quatrefoil(64, 64)}</g>`,
  );
}

/** Masks (only their shape matters; CSS gives them the theme's colour). */
const ornament = () =>
  svg(
    220,
    14,
    `<g fill="#000"><rect x="0" y="6.5" width="86" height="1"/><rect x="134" y="6.5" width="86" height="1"/><circle cx="94" cy="7" r="1.6"/><circle cx="126" cy="7" r="1.6"/><path fill-rule="evenodd" d="M110 1 L117 7 L110 13 L103 7 Z M110 4.2 L106.8 7 L110 9.8 L113.2 7 Z"/></g>`,
  );
const cornice = () =>
  svg(
    16,
    14,
    `<g fill="#000"><rect x="0" y="0" width="16" height="1.5"/><rect x="0" y="3" width="16" height=".75"/><rect x="4" y="5" width="8" height="5"/><rect x="0" y="11.5" width="16" height=".75"/></g>`,
  );

async function main() {
  await mkdir(OUT, { recursive: true });
  await paperGrain("paper-grain-light.webp", [74, 52, 30], 0.55, 11);
  await paperGrain("paper-grain-dark.webp", [255, 236, 204], 0.32, 12);
  await walnut("walnut.webp", 5);
  const drawings: Record<string, string> = {
    "footer-scene.svg": footerScene(),
    "sidebar-shelf.svg": sidebarShelf(),
    "sprig.svg": sprig(),
    "seal.svg": seal("#9e2f22"),
    "seal-dark.svg": seal("#d9826b"),
    "corner-tl.svg": corner(0),
    "corner-br.svg": corner(180),
    "wallpaper-light.svg": wallpaper("#6b4a24", 0.085, 0.07),
    "wallpaper-dark.svg": wallpaper("#f0dcb0", 0.05, 0.04),
    "ornament.svg": ornament(),
    "cornice.svg": cornice(),
  };
  for (const [file, content] of Object.entries(drawings)) {
    await writeFile(path.join(OUT, file), content);
  }
  console.log(
    `Wrote ${Object.keys(drawings).length + 3} assets to ${path.relative(process.cwd(), OUT)}`,
  );
}

await main();
