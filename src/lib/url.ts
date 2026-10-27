/**
 * An http(s) URL that may be shown as a link: parsed, with no user name or password (a link
 * reading `https://trusted.example@evil.example/` goes to evil.example). Returns the parsed
 * `href` (percent-encoded, so the text shown is the address followed), or null.
 */
export function linkableUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
  return url.href;
}
