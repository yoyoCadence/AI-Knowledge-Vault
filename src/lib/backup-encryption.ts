/**
 * Rules of built-in export encryption (ADR-022), shared by the server and the export panel so
 * the form refuses what the server would. Both aim at one thing: a backup that any age tool on
 * any computer can decrypt.
 */
export const PASSPHRASE_MIN = 12;
export const PASSPHRASE_MAX = 1024;
export const RECIPIENTS_MAX = 10;

/**
 * Printable ASCII only. `age -d` reads a passphrase as the bytes a terminal sends, and a
 * console in another code page (Big5 on a Traditional Chinese Windows) or another Unicode
 * normalization would send different bytes for the same non-ASCII text, and never decrypt.
 */
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/** An X25519 recipient, `age1` and 58 bech32 characters: the kind every age version reads. */
const X25519_RECIPIENT = /^age1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}$/;

export type PassphraseProblem = "characters" | "length";

export function passphraseProblem(passphrase: string): PassphraseProblem | null {
  if (!PRINTABLE_ASCII.test(passphrase)) return "characters";
  if (passphrase.length < PASSPHRASE_MIN || passphrase.length > PASSPHRASE_MAX) return "length";
  return null;
}

/** Recipients as typed: one per line (any whitespace), without repeats. */
export function recipientsFrom(text: string): string[] {
  return [...new Set(text.split(/\s+/).filter(Boolean))];
}

export type RecipientsProblem = "none" | "count" | "format";

export function recipientsProblem(recipients: string[]): RecipientsProblem | null {
  if (recipients.length === 0) return "none";
  if (recipients.length > RECIPIENTS_MAX) return "count";
  if (!recipients.every((recipient) => X25519_RECIPIENT.test(recipient))) return "format";
  return null;
}
