import type { ContentKind, PreviewKind } from "@/infrastructure/database/schema";
import type { ZipEntryInfo } from "./reader";

/**
 * ZIP classification (IMPORT_PIPELINE §3, FR-PRV-1). Pure function of the inventory: decides what
 * the archive is, where its entry document lives, which files form the previewable site, and
 * which file can serve as a cover. Nothing in the archive is ever executed or built.
 */
export type ArchiveKind =
  | "claude_design"
  | "static_site"
  | "prebuilt_site"
  | "framework_source"
  | "document_bundle"
  | "unsupported";

export interface ArchiveClassification {
  kind: ArchiveKind;
  contentKind: ContentKind;
  previewKind: PreviewKind;
  /** Common top-level folder stripped from all paths (zips of a folder), or "". */
  rootPrefix: string;
  /** Directory (relative to rootPrefix) whose files form the preview site, or null. */
  siteRoot: string | null;
  /** Entry document path (full archive path) to extract text from, or null. */
  entryPath: string | null;
  /** Entry path relative to the site root, for the preview iframe. */
  previewEntryPath: string | null;
  /** Archive path of a cover image candidate, or null. */
  coverPath: string | null;
  reason: string;
}

/** Files copied into the preview site (served script-free, see SECURITY.md §5). */
export const PREVIEW_EXTENSIONS = new Set([
  "html", "htm", "css", "js", "mjs", "json", "svg", "png", "jpg", "jpeg", "gif", "webp", "avif", "ico",
  "woff", "woff2", "ttf", "otf", "txt", "md", "pdf",
]); // prettier-ignore

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "avif"]);
const DOCUMENT_EXTENSIONS = new Map<string, number>([
  ["md", 3],
  ["markdown", 3],
  ["pdf", 2],
  ["txt", 1],
]);
const IGNORED = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/i;
// Prebuilt output folders. Not `public/`: in CRA/Vite sources it holds an unbuilt shell index.html.
const BUILD_DIRS = ["dist", "build", "out"];

export function extensionOf(path: string): string {
  const base = path.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

const depth = (path: string) => path.split("/").length;

function commonRootPrefix(paths: string[]): string {
  if (paths.length === 0) return "";
  const first = paths[0]!.split("/");
  if (first.length < 2) return "";
  const candidate = `${first[0]}/`;
  return paths.every((path) => path.startsWith(candidate) && path.length > candidate.length)
    ? candidate
    : "";
}

function shallowest(paths: string[]): string | null {
  return (
    [...paths].sort(
      (a, b) => depth(a) - depth(b) || a.length - b.length || a.localeCompare(b),
    )[0] ?? null
  );
}

function coverCandidate(
  files: ZipEntryInfo[],
  rootPrefix: string,
  siteRoot: string | null,
): string | null {
  const thumbnail = files.find(
    (file) =>
      file.path === `${rootPrefix}.thumbnail` ||
      file.path === `${rootPrefix}${siteRoot ?? ""}.thumbnail`,
  );
  if (thumbnail) return thumbnail.path;
  const images = files.filter(
    (file) => IMAGE_EXTENSIONS.has(extensionOf(file.path)) && file.size > 0,
  );
  const named = images.find((file) =>
    /(^|\/)(cover|thumbnail|screenshot|preview|og[-_]?image)\.[a-z]+$/i.test(file.path),
  );
  return named?.path ?? null;
}

export function classifyArchive(entries: ZipEntryInfo[]): ArchiveClassification {
  const files = entries.filter((entry) => !entry.isDirectory && !IGNORED.test(entry.path));
  const rootPrefix = commonRootPrefix(files.map((file) => file.path));
  const relative = (path: string) => path.slice(rootPrefix.length);
  const rel = files.map((file) => relative(file.path));
  const has = (path: string) => rel.includes(path);
  const base: Omit<ArchiveClassification, "kind" | "contentKind" | "previewKind" | "reason"> = {
    rootPrefix,
    siteRoot: null,
    entryPath: null,
    previewEntryPath: null,
    coverPath: null,
  };

  // 1. Claude Design export: a top-level *.dc.html (optionally with support.js / _ds / .thumbnail).
  const dcHtml = shallowest(rel.filter((path) => /\.dc\.html?$/i.test(path) && depth(path) <= 2));
  if (dcHtml) {
    const siteRoot = dcHtml.includes("/") ? `${dcHtml.split("/").slice(0, -1).join("/")}/` : "";
    return {
      ...base,
      kind: "claude_design",
      contentKind: "claude_design_document",
      previewKind: "static_site",
      siteRoot,
      entryPath: rootPrefix + dcHtml,
      previewEntryPath: dcHtml.slice(siteRoot.length),
      coverPath: coverCandidate(files, rootPrefix, siteRoot),
      reason: `Claude Design document ${dcHtml}`,
    };
  }

  // 2. Framework source project (React/Vite/Next…): never built here (FR-PRV-5).
  const hasPackageJson = has("package.json");
  const frameworkSignals = rel.filter((path) =>
    /^(vite|next|nuxt|svelte|astro|remix)\.config\.[cm]?[jt]s$|^src\/(main|index|app|App)\.[jt]sx?$|^tsconfig\.json$/i.test(
      path,
    ),
  );
  const prebuiltIndex = shallowest(
    rel.filter((path) => BUILD_DIRS.some((dir) => path === `${dir}/index.html`)),
  );
  if (hasPackageJson && frameworkSignals.length > 0) {
    if (prebuiltIndex) {
      const siteRoot = `${prebuiltIndex.split("/")[0]}/`;
      return {
        ...base,
        kind: "prebuilt_site",
        contentKind: "static_site",
        previewKind: "static_site",
        siteRoot,
        entryPath: rootPrefix + prebuiltIndex,
        previewEntryPath: "index.html",
        coverPath: coverCandidate(files, rootPrefix, siteRoot),
        reason: `framework project with prebuilt output in ${siteRoot}`,
      };
    }
    const readme = shallowest(
      rel.filter((path) => /(^|\/)readme(\.md|\.markdown|\.txt)?$/i.test(path)),
    );
    return {
      ...base,
      kind: "framework_source",
      contentKind: "framework_project",
      previewKind: "framework_source",
      entryPath: readme ? rootPrefix + readme : null,
      coverPath: coverCandidate(files, rootPrefix, null),
      reason: `source project (${frameworkSignals.slice(0, 3).join(", ")}) — build required`,
    };
  }

  // 3. Static website: shallowest index.html, else the only HTML file.
  const htmlFiles = rel.filter((path) => /\.html?$/i.test(path));
  const index = shallowest(htmlFiles.filter((path) => /(^|\/)index\.html?$/i.test(path)));
  const entry = index ?? (htmlFiles.length === 1 ? htmlFiles[0]! : null);
  if (entry) {
    const siteRoot = entry.includes("/") ? `${entry.split("/").slice(0, -1).join("/")}/` : "";
    return {
      ...base,
      kind: "static_site",
      contentKind: "static_site",
      previewKind: "static_site",
      siteRoot,
      entryPath: rootPrefix + entry,
      previewEntryPath: entry.slice(siteRoot.length),
      coverPath: coverCandidate(files, rootPrefix, siteRoot),
      reason: `static site with entry ${entry}`,
    };
  }

  // 4. Document bundle: the most "readable" document (md > pdf > txt), largest first.
  const documents = files
    .filter((file) => DOCUMENT_EXTENSIONS.has(extensionOf(file.path)))
    .sort(
      (a, b) =>
        DOCUMENT_EXTENSIONS.get(extensionOf(b.path))! -
          DOCUMENT_EXTENSIONS.get(extensionOf(a.path))! || b.size - a.size,
    );
  const document = documents[0];
  if (document) {
    const extension = extensionOf(document.path);
    return {
      ...base,
      kind: "document_bundle",
      contentKind: extension === "pdf" ? "pdf" : extension === "txt" ? "text" : "markdown",
      previewKind: extension === "pdf" ? "pdf" : "text_only",
      entryPath: document.path,
      coverPath: coverCandidate(files, rootPrefix, null),
      reason: `document bundle; primary document ${relative(document.path)}`,
    };
  }

  return {
    ...base,
    kind: "unsupported",
    contentKind: "archive_other",
    previewKind: "unsupported",
    coverPath: coverCandidate(files, rootPrefix, null),
    reason: files.length === 0 ? "empty archive" : "no HTML, Markdown, PDF or text document found",
  };
}

/** Archive paths that belong to the preview site (allowed types only), with site-relative paths. */
export function previewFiles(
  entries: ZipEntryInfo[],
  classification: ArchiveClassification,
): { archivePath: string; sitePath: string }[] {
  if (classification.siteRoot === null) return [];
  const prefix = classification.rootPrefix + classification.siteRoot;
  return entries
    .filter(
      (entry) => !entry.isDirectory && entry.path.startsWith(prefix) && !IGNORED.test(entry.path),
    )
    .filter((entry) => PREVIEW_EXTENSIONS.has(extensionOf(entry.path)))
    .map((entry) => ({ archivePath: entry.path, sitePath: entry.path.slice(prefix.length) }))
    .filter((file) => file.sitePath.length > 0);
}
