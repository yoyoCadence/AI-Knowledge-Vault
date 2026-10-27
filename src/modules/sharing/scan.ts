/**
 * The pattern scan behind the pre-share check (FR-SHR-3). Advisory: it looks for what commonly
 * leaks (keys and tokens of well-known services, private keys, email addresses, intranet URLs,
 * files that usually hold secrets), and can neither prove a document clean nor catch everything.
 * Every pattern is bounded and anchored to where a run starts, so a scan stays linear in the
 * text's length (adversarial inputs are in the unit tests).
 */

export interface ShareFinding {
  kind: "sensitive" | "secret" | "email" | "private_url" | "suspicious_file";
  /** Distinct values found (the same address twice counts once). */
  count: number;
  /** Up to three masked examples, so the owner can find them. */
  samples: string[];
}

// Token patterns start only where a run of token characters starts, and end where it ends:
// without the anchors, every position inside a long run (`-eyJ-eyJ…`) would begin a fresh
// attempt that scans up to thousands of characters, quadratic in the run's length.
const TOKEN_START = "(?<![A-Za-z0-9_-])";
const TOKEN_END = "(?![A-Za-z0-9_-])";
const SECRET_PATTERNS = [
  /-----BEGIN (?:[A-Z]{1,20} ){0,4}PRIVATE KEY-----/g,
  new RegExp(
    `${TOKEN_START}(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,200}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,255}|glpat-[A-Za-z0-9_-]{20,200}|xox[abprs]-[A-Za-z0-9-]{10,200}|AIza[0-9A-Za-z_-]{35})${TOKEN_END}`,
    "g",
  ),
  new RegExp(
    `${TOKEN_START}eyJ[A-Za-z0-9_-]{8,2000}\\.[A-Za-z0-9_-]{8,4000}\\.[A-Za-z0-9_-]{8,2000}${TOKEN_END}`,
    "g",
  ),
];
// Matches start only where a local part starts: without the lookbehind, every position inside
// a long run of letters would begin a fresh attempt (64 steps each).
const EMAIL =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.){1,8}[A-Za-z]{2,24}/g;
// The host must end the authority: `localhost.example.com` or `10.0.0.1.example.com` is public.
const PRIVATE_URL =
  /\bhttps?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|(?:[A-Za-z0-9-]{1,63}\.){1,8}(?:local|internal|corp|lan|intranet))(?![A-Za-z0-9-]|\.[A-Za-z0-9])/gi;
const SUSPICIOUS_FILE =
  /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.git\/.*|\.npmrc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|[^/]*\.(?:pem|key|p12|pfx|keystore|jks)|credentials(?:\.[^/]*)?|secrets?\.(?:json|ya?ml|toml|env))$/i;

/** Keeps the start and end of a match: enough to find it, not enough to reuse it. */
function mask(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= 8) return `${chars[0] ?? ""}…`;
  return `${chars.slice(0, 4).join("")}…${chars.slice(-2).join("")}`;
}

/** Distinct matches: the same address in a link's label and its destination counts once. */
function scan(kind: ShareFinding["kind"], text: string, patterns: RegExp[]): ShareFinding | null {
  const seen = new Set<string>();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) seen.add(match[0]);
  }
  if (seen.size === 0) return null;
  return { kind, count: seen.size, samples: Array.from(seen, mask).slice(0, 3) };
}

/** CommonMark backslash escapes (`\_`, `\*`, …), undone so they cannot split a token. */
const MARKDOWN_ESCAPE = /\\([!-/:-@[-`{-~])/g;

/**
 * Text as the reader shows it: normalized Markdown, unescaped. Extracted plain text alone is not
 * enough: it keeps link labels without their destinations, and leaves out raw HTML blocks,
 * which reading mode shows as text.
 */
export function readableMarkdown(markdown: string): string {
  return markdown.replace(MARKDOWN_ESCAPE, "$1");
}

/** What in `text` looks like secrets, email addresses or private URLs (distinct values). */
export function scanShareText(text: string): ShareFinding[] {
  return [
    scan("secret", text, SECRET_PATTERNS),
    scan("email", text, [EMAIL]),
    scan("private_url", text, [PRIVATE_URL]),
  ].filter((finding): finding is ShareFinding => finding !== null);
}

/** Preview files whose names usually hold secrets (`.env`, private keys, credentials). */
export function suspiciousFiles(paths: string[]): ShareFinding | null {
  const suspicious = paths.filter((path) => SUSPICIOUS_FILE.test(path));
  return suspicious.length > 0
    ? { kind: "suspicious_file", count: suspicious.length, samples: suspicious.slice(0, 3) }
    : null;
}
