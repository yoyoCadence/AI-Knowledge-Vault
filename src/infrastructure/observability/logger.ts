import pino, { type Logger } from "pino";

/**
 * Structured JSON logger (docs/ARCHITECTURE.md §6).
 *
 * Redaction is defensive: callers must still never pass document bodies, passwords or tokens.
 */
const REDACT_PATHS = [
  "password",
  "*.password",
  "token",
  "*.token",
  "secret",
  "*.secret",
  "authorization",
  "*.authorization",
  "cookie",
  "*.cookie",
  "headers.cookie",
  "headers.authorization",
  "apiKey",
  "*.apiKey",
  "accessKeyId",
  "*.accessKeyId",
  "secretAccessKey",
  "*.secretAccessKey",
  "uploadUrl",
  "*.uploadUrl",
  "downloadUrl",
  "*.downloadUrl",
  "signedUrl",
  "*.signedUrl",
];

let root: Logger | undefined;

function createRootLogger(): Logger {
  const level = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info");
  return pino({
    level,
    base: { service: process.env.SERVICE_NAME ?? "vault" },
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
}

export function getLogger(bindings?: Record<string, unknown>): Logger {
  root ??= createRootLogger();
  return bindings ? root.child(bindings) : root;
}

export type { Logger };
