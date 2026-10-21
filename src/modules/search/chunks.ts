/**
 * Splits an extraction's plain text into search chunks (docs/SEARCH_DESIGN.md §3). Chunks
 * follow the document's sections; a section longer than `maxChars` is split at a paragraph or
 * sentence boundary when one exists, with `overlap` characters repeated so a phrase cut by a
 * boundary is still found. Offsets are exact positions in the plain text (for snippets now,
 * citations later). These are the same units Phase 2 will embed.
 */

export interface ChunkDraft {
  ordinal: number;
  text: string;
  charStart: number;
  charEnd: number;
  /** Ordinal of the section the chunk belongs to, or null for a document without sections. */
  sectionOrdinal: number | null;
}

export const CHUNK_MAX_CHARS = 1_200;
export const CHUNK_OVERLAP = 100;

const PARAGRAPH = /\n\s*\n/g;
const SENTENCE = /[。！？!?；;]|\.(?=\s)|\n/g;

/**
 * Moves a UTF-16 index that falls inside a surrogate pair back to the pair's start, so a cut
 * never splits a character (an emoji, a CJK Extension B character).
 */
function charBoundary(text: string, index: number): number {
  const low = text.charCodeAt(index);
  const high = text.charCodeAt(index - 1);
  return low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff ? index - 1 : index;
}

/** The last boundary in text[from, to) that ends a paragraph or sentence, or null. */
function lastBoundary(text: string, from: number, to: number): number | null {
  const window = text.slice(from, to);
  for (const pattern of [PARAGRAPH, SENTENCE]) {
    let best: number | null = null;
    for (const match of window.matchAll(pattern)) best = from + match.index + match[0].length;
    if (best !== null) return best;
  }
  return null;
}

export function chunkText(
  plainText: string,
  sections: { ordinal: number; charStart: number; charEnd: number }[],
  options: { maxChars?: number; overlap?: number } = {},
): ChunkDraft[] {
  const maxChars = options.maxChars ?? CHUNK_MAX_CHARS;
  const overlap = Math.min(options.overlap ?? CHUNK_OVERLAP, Math.floor(maxChars / 4));
  const ranges =
    sections.length > 0
      ? sections.map((section) => ({
          start: section.charStart,
          end: Math.min(section.charEnd, plainText.length),
          ordinal: section.ordinal as number | null,
        }))
      : [{ start: 0, end: plainText.length, ordinal: null }];

  const chunks: ChunkDraft[] = [];
  for (const range of ranges) {
    let start = range.start;
    while (start < range.end) {
      let end = Math.min(start + maxChars, range.end);
      if (end < range.end) {
        // Prefer a natural boundary in the second half of the window.
        end = lastBoundary(plainText, start + Math.floor(maxChars / 2), end) ?? end;
        const safe = charBoundary(plainText, end);
        end = safe > start ? safe : end + 1;
      }
      const text = plainText.slice(start, end);
      if (text.trim()) {
        chunks.push({
          ordinal: chunks.length,
          text,
          charStart: start,
          charEnd: end,
          sectionOrdinal: range.ordinal,
        });
      }
      if (end >= range.end) break;
      const next = charBoundary(plainText, end - overlap);
      start = next > start ? next : end;
    }
  }
  return chunks;
}
