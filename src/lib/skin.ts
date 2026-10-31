/**
 * The app's skin (docs/THEME.md): "archive", the reading room, or "plain", the neutral look.
 * A per-viewer convenience kept in a cookie, like the library layout: the root layout reads it
 * and sets `<html data-skin>`, so the first paint already has the chosen skin. Anything else
 * in the cookie means the default.
 */
export const SKIN_COOKIE = "vault_skin";
export const SKINS = ["archive", "plain"] as const;
export type Skin = (typeof SKINS)[number];
export const DEFAULT_SKIN: Skin = "archive";

export function skinOf(value: string | undefined): Skin {
  return value === "plain" ? "plain" : DEFAULT_SKIN;
}
