/**
 * Limits of built-in export encryption (ADR-022), shared by the server's check and the export
 * panel's: a passphrase of 12 or more characters (as account passwords), or 1–10 recipients.
 */
export const PASSPHRASE_MIN = 12;
export const PASSPHRASE_MAX = 1024;
export const RECIPIENTS_MAX = 10;
