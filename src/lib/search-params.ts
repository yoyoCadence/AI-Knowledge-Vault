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
