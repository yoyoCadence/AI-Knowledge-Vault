import { filenameStem } from "@/modules/extraction";

/**
 * Identity keys for deterministic version matching (IMPORT_PIPELINE §6, ARCHITECTURE_REVIEW F-05).
 * Two uploads with the same *distinctive* key in one workspace are versions of the same artifact.
 */
const GENERIC_STEMS = new Set([
  "index",
  "report",
  "document",
  "untitled",
  "download",
  "export",
  "main",
  "readme",
  "output",
  "project",
  "design",
  "new",
  "file",
  "page",
  "site",
  "website",
  "home",
  "draft",
  "notes",
]);

const COPY_SUFFIXES = [
  /\s*\(\d+\)$/, // "name (1)"
  /[\s_-]+copy(\s*\d+)?$/i, // "name copy", "name-copy 2"
  /[\s_-]+(final|latest|new|updated|revised)$/i,
  /[\s_-]*v\d+(\.\d+)*$/i, // "_v2", " v3", "-v1.2"
  /[\s_-]+\d{4}-?\d{2}-?\d{2}(t\d{4,6})?$/i, // "-2026-10-20", "_20261020T1200"
  /[\s_-]+副本(\s*\d+)?$/, // "名稱 副本"
];

export const GENERIC_KEY_PREFIX = "generic:";
export const MIN_DISTINCTIVE_KEY_LENGTH = 6;

/** Normalized key; generic or too-short keys are prefixed with `generic:` and never matched. */
export function identityKeyFor(filename: string): string {
  let key = filenameStem(filename).normalize("NFKC").toLowerCase().trim();
  for (let changed = true; changed;) {
    changed = false;
    for (const pattern of COPY_SUFFIXES) {
      const next = key.replace(pattern, "").trim();
      if (next !== key && next.length > 0) {
        key = next;
        changed = true;
      }
    }
  }
  key = key
    .replace(/[_\-\s.]+/g, " ")
    .trim()
    .slice(0, 200);
  const distinctive = key.length >= MIN_DISTINCTIVE_KEY_LENGTH && !GENERIC_STEMS.has(key);
  return distinctive ? key : `${GENERIC_KEY_PREFIX}${key}`;
}

export function isDistinctiveKey(key: string): boolean {
  return !key.startsWith(GENERIC_KEY_PREFIX);
}
