/** A page's `searchParams` as Next.js passes them: a repeated key (`?q=a&q=b`) is an array. */
export type PageSearchParams = Record<string, string | string[] | undefined>;

/** The first value of a search parameter, like `URLSearchParams.get`. */
export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * A search query from the URL: trimmed and cut to `max` characters by code point, so the cut
 * never leaves half a surrogate pair (which `encodeURIComponent` rejects when building the
 * next-page link).
 */
export function searchQueryParam(value: string | string[] | undefined, max = 200): string {
  return Array.from((firstParam(value) ?? "").trim())
    .slice(0, max)
    .join("")
    .trim();
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A YYYY-MM-DD day that exists and that Postgres accepts (year 1 or later), else undefined.
 * `2026-02-30` and `0000-01-01` are dropped rather than passed on.
 */
export function dayParam(value: string | string[] | undefined): string | undefined {
  const day = firstParam(value);
  if (!day || !DAY.test(day) || day < "0001-01-01") return undefined;
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day ? undefined : day;
}

/**
 * A source model to filter by, exactly as recorded (stored values are not trimmed, so neither
 * is this): 1–200 characters without control characters, else undefined.
 */
export function modelParam(value: string | string[] | undefined): string | undefined {
  const model = firstParam(value);
  if (!model || /\p{Cc}/u.test(model) || Array.from(model).length > 200) return undefined;
  return model;
}
