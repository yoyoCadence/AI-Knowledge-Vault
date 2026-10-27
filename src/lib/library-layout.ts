/**
 * How the library lists works: cards with thumbnails, or one row per work. A per-viewer
 * convenience kept in a cookie (set by the page's switch, read by the page), so every library
 * link keeps it without carrying it in its URL. Anything else in the cookie means the grid.
 */
export const LIBRARY_LAYOUT_COOKIE = "vault_library_layout";
export const LIBRARY_LAYOUTS = ["grid", "list"] as const;
export type LibraryLayout = (typeof LIBRARY_LAYOUTS)[number];

export function libraryLayout(value: string | undefined): LibraryLayout {
  return value === "list" ? "list" : "grid";
}
