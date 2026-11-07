/**
 * Which images reading mode may show, and from where (docs/SECURITY.md §5 "Reading mode").
 * Reading never loads anything from elsewhere: a remote image would tell its host who reads
 * what, and when. So an image in a document is shown only when its bytes are already ours:
 *
 * - a `data:` raster image (PNG, JPEG, GIF, WebP, AVIF) written into the document itself. It
 *   is part of the stored text, and a raster image cannot run anything. SVG is left out.
 * - a file of the document's own bundle (a static-site ZIP, Claude Design included), served
 *   from the preview origin with the version's preview token, like the preview itself
 *   (ADR-007), so untrusted bytes never come from the app origin. Only a path that resolves
 *   inside the bundle to one of its stored image files qualifies.
 *
 * Everything else (http(s), protocol-relative, any other scheme, a file the bundle does not
 * hold) is null: reading mode shows its alt text instead, as before.
 */
export interface ReaderImages {
  /** `${PREVIEW_ORIGIN}/p/<token>/` when the version's preview files can be served; else null. */
  previewBase: string | null;
  /** The entry document's path in the bundle: relative URLs resolve against its folder. */
  entryPath: string | null;
  /** The image files among the version's preview files, as stored (decoded, NFC). */
  files: readonly string[];
}

/** About 6 MB of image. A longer `data:` URL is shown as its alt text. */
export const DATA_IMAGE_MAX_LENGTH = 8_000_000;
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/]+={0,2}$/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const BUNDLE = "https://bundle.invalid/";

const fileSets = new WeakMap<readonly string[], Set<string>>();
function fileSet(files: readonly string[]): Set<string> {
  let set = fileSets.get(files);
  if (!set) fileSets.set(files, (set = new Set(files)));
  return set;
}

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** The `src` reading mode may use for a document image's URL, or null (show the alt text). */
export function readerImageSrc(url: string, images?: ReaderImages | null): string | null {
  const trimmed = url.trim();
  if (/^data:/i.test(trimmed)) {
    if (trimmed.length > DATA_IMAGE_MAX_LENGTH) return null;
    const compact = trimmed.replace(/\s+/g, "");
    return DATA_IMAGE.test(compact) ? compact : null;
  }
  if (!images?.previewBase || images.files.length === 0) return null;
  if (SCHEME.test(trimmed) || trimmed.startsWith("//") || trimmed.startsWith("\\")) return null;
  const pathPart = trimmed.split(/[?#]/, 1)[0] ?? "";
  if (!pathPart || pathPart.includes("\\")) return null;

  const entry = images.entryPath ?? "";
  const folder = entry.slice(0, entry.lastIndexOf("/") + 1);
  let resolved: URL;
  try {
    resolved = new URL(pathPart, BUNDLE + encodePath(folder));
  } catch {
    return null;
  }
  // `..` past the root stays at the root: URL resolution clamps it, so nothing escapes.
  if (`${resolved.origin}/` !== BUNDLE) return null;
  const segments: string[] = [];
  for (const raw of resolved.pathname.slice(1).split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw).normalize("NFC");
    } catch {
      return null;
    }
    if (!segment || segment.includes("/") || /[\u0000-\u001f\u007f]/.test(segment)) return null;
    segments.push(segment);
  }
  const path = segments.join("/");
  if (!fileSet(images.files).has(path)) return null;
  return images.previewBase + encodePath(path);
}
