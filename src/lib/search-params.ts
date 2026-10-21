/** A page's `searchParams` as Next.js passes them: a repeated key (`?q=a&q=b`) is an array. */
export type PageSearchParams = Record<string, string | string[] | undefined>;

/** The first value of a search parameter, like `URLSearchParams.get`. */
export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
