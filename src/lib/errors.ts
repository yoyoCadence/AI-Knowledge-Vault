/**
 * Application error model (docs/API_CONTRACT.md §1, §13).
 * `message` must be safe to show to end users; never include secrets or document content.
 */
export const ErrorCodes = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  CSRF_REJECTED: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  UNSUPPORTED_MEDIA_TYPE: 415,
  CONFLICT: 409,
  NOT_RETRYABLE: 409,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_FILE_TYPE: 422,
  UPLOAD_INCOMPLETE: 409,
  SIZE_MISMATCH: 422,
  ARCHIVE_REJECTED: 422,
  PROCESSING_TIMEOUT: 504,
  EXTRACTION_FAILED: 422,
  STORAGE_UNAVAILABLE: 503,
  CHECKSUM_MISMATCH: 422,
  UNSUPPORTED_EXPORT_FORMAT: 422,
  /** An encrypted backup that the given passphrase or identities do not open, or a damaged one. */
  DECRYPTION_FAILED: 422,
  /** A stored original's bytes no longer match its recorded SHA-256 (storage corruption). */
  ORIGINAL_CORRUPT: 500,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ErrorCodes;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  /** Whether a background job hitting this error should retry. */
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; cause?: unknown; retryable?: boolean } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.status = ErrorCodes[code];
    this.details = options.details;
    this.retryable = options.retryable ?? (this.status >= 500 && code !== "PROCESSING_TIMEOUT");
  }
}

export const isAppError = (value: unknown): value is AppError => value instanceof AppError;

export const notFound = (what = "Resource") => new AppError("NOT_FOUND", `${what} not found`);
