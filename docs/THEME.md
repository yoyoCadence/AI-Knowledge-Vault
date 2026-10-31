# Skins (visual themes)

The app has two skins, chosen per browser:

- **archive (典藏室), the default:** a reading room with a card catalogue. The sidebar is a
  walnut catalogue cabinet, content sits on archival paper, and a bookshelf closes every page.
  Dark mode is the same room at night, lit by reading lamps.
- **plain (簡潔):** the original neutral look, unchanged.

Light, dark and system mode (next-themes) work in both skins.

## 1. How it works

| Piece               | Where                                                                                                                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Choice              | Cookie `vault_skin` (`src/lib/skin.ts`), read by the root layout into `<html data-skin>`. So the first paint already has the skin: no flash, no inline script. Anything but `plain` means `archive`.                                                                                                   |
| Switch              | `SkinToggle` (palette icon), next to the light/dark toggle: in the sidebar, the mobile drawer and on the login page. It sets `data-skin` at once and writes the cookie (one year), like the library's layout switch.                                                                                   |
| Styles              | `src/app/_skins/archive/archive.css`, imported by `globals.css`. Every rule starts with `:root[data-skin="archive"]` (a unit test checks this), so the plain skin is exactly what it was.                                                                                                              |
| Hooks               | Components carry `data-slot` / `data-region` attributes: `card`, `card-title`, `button` + `data-variant`, `badge`, `empty-state`, `catalog-card`/`-thumb`/`-body`, `catalog-row`, `ledger`, `login-card`, `nameplate`, `cabinet`, `topbar`. Raw panels use the `.surface-panel` class (`globals.css`). |
| Decoration elements | Three empty, `aria-hidden` divs, hidden unless the skin shows them: `cabinet-shelf` (sidebar foot), `cornice` (top of the content column), `scene` (end of every page; also the login and share pages).                                                                                                |
| Assets              | `src/app/_skins/archive/assets/`, referenced by relative `url()` from the CSS. Next bundles them into `/_next/static/media/` with hashed names, so they are cached for good and are not caught by `proxy.ts` (which redirects signed-out requests for anything else, `/public` included, to `/login`). |

The skin's rules are **unlayered on purpose**: they must beat the utilities that draw the plain
skin (`bg-surface`, `rounded-lg`, `shadow-xs`). They set only paint (colour, background,
border, radius, shadow, font), never layout, except the ledger's padding (room for its margin
rules and seal).

Tokens: the skin redefines the semantic tokens of `globals.css` (`--background`, `--surface`,
`--primary` …) and adds `--font-display`, `--ornament`, `--brass`, `--catalog-rule`,
`--sheet-behind`, `--paper-shadow` and `--highlight`. Inside the cabinet and the mobile top bar
the tokens are redefined again for wood, so every link, button and badge there follows without
per-component rules.

## 2. Regions, assets, presentation

| Region                                   | Asset                                                         | Presentation                                                                                                                                                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page (the room's wall)                   | `wallpaper-{light,dark}.svg`, `paper-grain-{light,dark}.webp` | `body` background layers with a CSS window-light glow (light) or lamp glow (dark). Scrolls with the page; no fixed layer.                                                                                                                                            |
| End of every page                        | `footer-scene.svg`                                            | A bookshelf (books, archive boxes, plants, a banker's lamp, a globe). `background-size: cover`: the whole shelf on desktop, its middle (lamp, books, plant) on a phone; 132 px tall, 96 px on phones.                                                                |
| Sidebar, mobile drawer, mobile top bar   | `walnut.webp`, `sidebar-shelf.svg`                            | A catalogue cabinet: wood with edge shading, the app name on a brass plate, the current page as a cream label card in a brass holder. Books on the cabinet's bottom shelf, dropped below 760 px of window height. The top bar has a brass rail and no backdrop blur. |
| Top of the content column (≥ 1024 px)    | `cornice.svg` (mask)                                          | A dentil cornice in the ornament colour.                                                                                                                                                                                                                             |
| Cards (detail page, usage, share reader) | `corner-tl.svg`, `corner-br.svg`, grain                       | Archival sheets: brass photo corners, a double rule, a second sheet behind. The middle is plain paper for reading.                                                                                                                                                   |
| Library cards and rows, search results   | CSS only                                                      | Catalogue cards: a red rule under the picture and the rod hole at the foot; rows keep the red rule on their left edge. A slight lift on hover (none with reduced motion). The thumbnail is untouched.                                                                |
| Library statistics                       | `seal-{,dark}.svg`                                            | A ledger page: double red margin rules, the seal stamped over its top-right edge, never over text.                                                                                                                                                                   |
| Empty states                             | `sprig.svg`                                                   | An empty drawer: paper, a brass dashed edge, a pressed sprig in the corner.                                                                                                                                                                                          |
| Login                                    | `seal.svg`, `sprig.svg`, `footer-scene.svg`                   | A reader's card: double rule, seal, the sprig below its last line, the shelf at the foot of the window.                                                                                                                                                              |
| Page titles, section and card titles     | `ornament.svg` (mask), system serif fonts                     | `--font-display` (Iowan Old Style, Palatino, Georgia, then Noto Serif TC, Songti TC, PMingLiU). Page titles get a rule with a lozenge. No web fonts: product principle P-9 (no new external dependency).                                                             |
| Buttons, badges, inputs                  | CSS only                                                      | Small radius (0.3 rem), an inked primary button, tag-like badges, inputs with a brass-brown edge.                                                                                                                                                                    |

## 3. Assets

All are generated by `scripts/skin-assets.ts` (`pnpm tsx scripts/skin-assets.ts`), which is
the record of how each was made. **No image model was used:** none was available when the skin
was built. Textures are seeded noise; scenery is composed from shapes. Every random choice
comes from a fixed seed, so a rerun reproduces the files exactly.

| File                                        | Size   | Made from                                                                                                                                                    |
| ------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `paper-grain-light.webp`                    | ~30 KB | 256 px tile, transparent; 4 octaves of periodic value noise (mottling) + 90 curved fibres + speckle, brown `rgb(74 52 30)`, strength 0.55; seed 11           |
| `paper-grain-dark.webp`                     | ~27 KB | the same, cream `rgb(255 236 204)`, strength 0.32; seed 12                                                                                                   |
| `walnut.webp`                               | ~4 KB  | 256 × 512 tile; 7 sine grain cycles across, bent by periodic noise, streaks and 900 pores; seed 5                                                            |
| `footer-scene.svg`                          | ~29 KB | 1600 × 160; three runs of books, three archive boxes, two plants, a banker's lamp with a radial glow, a stack, a globe, the shelf board; seed 20261031       |
| `sidebar-shelf.svg`                         | ~5 KB  | 240 × 120; books, a brass bookend, the board; seed 1987                                                                                                      |
| `seal.svg`, `seal-dark.svg`                 | ~2 KB  | an ink stamp: rings, an open book, a star and "AI KNOWLEDGE VAULT · ARCHIVE ·" on a circle, roughened by an SVG turbulence filter; red `#9e2f22` / `#d9826b` |
| `sprig.svg`                                 | ~2 KB  | nine leaves along a Bézier stem, three berries; seed 77                                                                                                      |
| `corner-tl.svg`, `corner-br.svg`            | <1 KB  | a brass photo-corner mount with a rivet                                                                                                                      |
| `wallpaper-light.svg`, `wallpaper-dark.svg` | <1 KB  | 64 px diamond lattice with quatrefoils at 4–9 % opacity                                                                                                      |
| `ornament.svg`, `cornice.svg`               | <1 KB  | masks (shape only; CSS colours them)                                                                                                                         |

### Replacing an asset with a generated image

Each asset fills a slot that a raster image can take over: keep its file name or change the
`url()` in `archive.css`, and keep its constraints. If an image model becomes available, these
are the briefs (not used so far):

- **`footer-scene`** — "A long, low wooden bookshelf seen straight on, in a warm reading room:
  cloth-bound books in oxblood, library green, navy, ochre and vellum, archive boxes with brass
  label holders, a potted fern, a green banker's lamp glowing softly, a small globe. Flat
  illustrated style with gentle shading, muted colours, plain transparent background above the
  shelf. Ultra-wide 10:1; the middle third must work alone, cropped for a phone." Export WebP
  with alpha, about 2400 × 240.
- **`walnut`** — "Seamless tileable walnut wood texture, vertical straight grain, dark brown,
  even lighting, no knots." Must stay dark enough for cream text (check with the contrast
  table below); 256 × 512, WebP.
- **`paper-grain`** — "Seamless tileable fine paper fibre texture, very subtle." Must be
  transparent and faint: text contrast is checked on its darkest fibres.

## 4. Rules the skin keeps

- **Content stays native and readable.** Text, data, buttons and forms are the app's own; no
  picture contains interface. Paper behind text is flat colour with a faint grain; decoration
  sits at edges and corners.
- **Contrast** (WCAG AA), computed for both modes, including text over the darkest grain fibre
  and the lightest wood: body and muted text ≥ 4.5:1 everywhere (lowest: muted text on the
  grained wall, 4.74), primary buttons 7.3 / 8.5, focus rings and input edges ≥ 3:1. Status
  colours (danger, success, warning badges) keep their meaning and pass.
- **User content is untouched.** Thumbnails, reading-mode images and the sandboxed preview are
  never filtered, blended, recoloured or covered; the stylesheet may not name `img`, `video`,
  `iframe` or use `filter` (a unit test checks).
- **Decoration never gets in the way:** every decorative element and pseudo-element has
  `pointer-events: none`, is `aria-hidden` or generated content, and is never focusable.
- **Motion:** only the catalogue card's hover lift; none with `prefers-reduced-motion`.
- **Phones:** the shelf is cropped to its middle and shorter, the cornice is not shown, the
  seal is smaller and its text margin narrower, the cabinet's shelf goes on short windows.
- **Cost:** about 110 KB of assets in all, three background layers on the page, no fixed
  layers, no blur (the top bar's backdrop blur is turned off in this skin).

## 5. Verification (2026-10-31)

Checked in Chromium (Playwright) against the dev server with a separate, seeded database: 7
synthetic works (Markdown, HTML, text, an image, a very long title), tags and a share link.

- Desktop 1440 × 900 and phone width 390 × 844 (emulated, not a physical phone), light and
  dark: login, library (empty, grid, list, search), a work's detail page, import, tags,
  projects, collections, settings, usage, a future-feature page, 404, the mobile drawer and the
  public share reader.
- No page scrolls sideways at either width; no console errors or failed asset requests
  (beyond the intended 404 page).
- The switch: plain applies at once, survives a reload, and switches back.
- The plain skin renders as before.

Not verified: Safari and Firefox, physical phones, and screen-reader output (the decoration
is `aria-hidden` or CSS-generated; no text was added).

## 6. Adding a skin

Add a value to `SKINS` in `src/lib/skin.ts` (and to `skinOf` and the toggle), create
`src/app/_skins/<name>/<name>.css` with every rule scoped to `:root[data-skin="<name>"]`,
import it from `globals.css`, and dress the existing hooks. Do not add hooks for one page;
reuse the slots above.
