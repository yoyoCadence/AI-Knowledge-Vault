/**
 * The pattern scan behind the pre-share check (FR-SHR-3). Advisory: it looks for what commonly
 * leaks (keys and tokens of well-known services, private keys, email addresses, intranet URLs,
 * files that usually hold secrets), and can neither prove a document clean nor catch everything.
 * Every pattern is bounded, so a scan stays linear in the text's length.
 */

export interface ShareFinding {
  kind: "sensitive" | "secret" | "email" | "private_url" | "suspicious_file";
  count: number;
  /** Up to three masked examples, so the owner can find them. */
  samples: string[];
}

const SECRET_PATTERNS = [
  /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g,
  /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,200}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,255}|glpat-[A-Za-z0-9_-]{20,200}|xox[abprs]-[A-Za-z0-9-]{10,200}|AIza[0-9A-Za-z_-]{35})\b/g,
  /\beyJ[A-Za-z0-9_-]{8,2000}\.[A-Za-z0-9_-]{8,4000}\.[A-Za-z0-9_-]{8,2000}/g,
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

function scan(kind: ShareFinding["kind"], text: string, patterns: RegExp[]): ShareFinding | null {
  const samples: string[] = [];
  let count = 0;
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      count += 1;
      if (samples.length < 3) samples.push(mask(match[0]));
    }
  }
  return count > 0 ? { kind, count, samples } : null;
}

// Destinations in our normalized Markdown: inline links and images `](url)`, autolinks
// `<scheme:…>`, and reference definitions `[id]: url`. Every part is bounded and starts at a
// literal, so extraction stays linear.
const LINK_DESTINATION =
  /\]\(\s{0,8}<?([^\s<>()]{1,2048})|<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]{1,2048})>|^ {0,3}\[[^\]\n]{1,999}\]:[ \t]{0,8}<?([^\s<>]{1,2048})/gm;

/**
 * The link and image destinations of normalized Markdown. Extracted text keeps only link
 * labels, but the reader renders these as links, so the scan must see them too.
 */
export function linkDestinations(markdown: string): string[] {
  return Array.from(
    markdown.matchAll(LINK_DESTINATION),
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  );
}

/** What in `text` looks like secrets, email addresses or private URLs. */
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
