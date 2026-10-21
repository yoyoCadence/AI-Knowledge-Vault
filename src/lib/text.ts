import { AppError } from "@/lib/errors";

/**
 * Validation of short user-entered text (titles, descriptions) shared by every module that
 * stores it, so artifacts and projects follow the same rules. Lengths are counted in code
 * points, like the database's `char_length`.
 */

/** Bidirectional embeddings, overrides and isolates: they can make text display as other text. */
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/u;
/**
 * The rest of Unicode's Bidi_Control set, the directional marks (ALM, LRM, RLM). They only move
 * where neutral characters such as punctuation display, but that is enough to disguise a name,
 * so they are stripped, as in tag names, rather than refused.
 */
const BIDI_MARKS = /[\u061c\u200e\u200f]/gu;
/** Characters that never render, and symbols whose glyph is blank. */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}|[\u2800\u{1d159}]/gu;
const VISIBLE = /[\p{L}\p{N}\p{P}\p{S}]/u;
/** Control characters other than tab and line feed (C0 and C1), and lone surrogates. */
const NOT_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]|\p{Cs}/u;

const length = (text: string) => Array.from(text).length;

/**
 * A single-line title: NFC, directional marks stripped, whitespace collapsed, trimmed,
 * 1–`max` characters, with at least one visible character and no other bidirectional controls.
 */
export function cleanTitle(input: string, max: number, what = "Titles"): string {
  const title = input.normalize("NFC").replace(BIDI_MARKS, "").replace(/\s+/gu, " ").trim();
  if (
    !title ||
    NOT_TEXT.test(title) ||
    BIDI_CONTROLS.test(title) ||
    !VISIBLE.test(title.replace(INVISIBLE, ""))
  ) {
    throw new AppError("VALIDATION_FAILED", `${what} must be visible text`);
  }
  if (length(title) > max) {
    throw new AppError("VALIDATION_FAILED", `${what} are at most ${max} characters`);
  }
  return title;
}

/**
 * Multi-line text: NFC, directional marks stripped, line endings normalized to `\n`, trimmed,
 * at most `max` characters, no control characters other than tab and line feed and no other
 * bidirectional controls. Empty becomes null.
 */
export function cleanDescription(
  input: string | null,
  max: number,
  what = "Descriptions",
): string | null {
  if (input === null) return null;
  const text = input.normalize("NFC").replace(BIDI_MARKS, "").replace(/\r\n?/g, "\n").trim();
  if (NOT_TEXT.test(text) || BIDI_CONTROLS.test(text)) {
    throw new AppError("VALIDATION_FAILED", `${what} must be text`);
  }
  if (length(text) > max) {
    throw new AppError("VALIDATION_FAILED", `${what} are at most ${max} characters`);
  }
  return text || null;
}

/** Line endings as `cleanDescription` stores them, for comparing an edit with the original. */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}
