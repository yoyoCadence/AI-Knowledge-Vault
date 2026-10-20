import { z } from "zod";

/**
 * Environment configuration (docs/DEPLOYMENT.md §4, docs/SECURITY.md §10).
 *
 * Parsed lazily on first use so that `next build` and unit tests can import modules
 * without a full runtime environment. Validation errors list variable names and
 * problems, never values.
 */

const MiB = 1024 * 1024;

const secret = (name: string) =>
  z
    .string({ error: `${name} is required` })
    .min(32, { error: `${name} must be at least 32 characters` });

const origin = z
  .url()
  .transform((value) => new URL(value).origin)
  .describe("scheme://host[:port] without a path");

const booleanFlag = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((value) => value === "true" || value === "1");

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    /** Required when NODE_ENV=production so a real deployment never validates as "development". */
    APP_ENV: z.enum(["development", "test", "staging", "production"]).optional(),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),

    APP_ORIGIN: origin,
    PREVIEW_ORIGIN: origin,

    DATABASE_URL: z.string().min(1, { error: "DATABASE_URL is required" }),
    DATABASE_POOL_MAX: positiveInt(10),

    BETTER_AUTH_SECRET: secret("BETTER_AUTH_SECRET"),
    /** Comma-separated reverse-proxy IPs/CIDRs whose X-Forwarded-For hops are trusted (rate limiting). */
    TRUSTED_PROXIES: z
      .string()
      .optional()
      .transform((value) =>
        (value ?? "")
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
      ),
    PREVIEW_TOKEN_SECRET: secret("PREVIEW_TOKEN_SECRET"),

    STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
    LOCAL_STORAGE_DIR: z.string().default("./.data/storage"),
    LOCAL_STORAGE_SIGNING_SECRET: z.string().optional(),
    ALLOW_LOCAL_STORAGE_IN_PRODUCTION: booleanFlag,
    S3_ENDPOINT: z.url().optional(),
    S3_REGION: z.string().default("auto"),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: booleanFlag,

    IMPORT_MAX_FILE_BYTES: positiveInt(200 * MiB),
    /** Larger files are preserved but not parsed (preservation never depends on parsing). */
    EXTRACT_MAX_BYTES: positiveInt(50 * MiB),
    IMPORT_MAX_ITEMS_PER_BATCH: positiveInt(500),
    IMPORT_ITEM_TIMEOUT_MS: positiveInt(300_000),
    UPLOAD_URL_TTL_SECONDS: positiveInt(900),
    ZIP_MAX_ENTRIES: positiveInt(5_000),
    ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES: positiveInt(512 * MiB),
    ZIP_MAX_ENTRY_BYTES: positiveInt(128 * MiB),
    ZIP_MAX_COMPRESSION_RATIO: positiveInt(200),
    ZIP_MAX_PATH_DEPTH: positiveInt(24),
    PDF_MAX_PAGES: positiveInt(2_000),
    PREVIEW_MAX_FILES: positiveInt(2_000),
    PREVIEW_MAX_TOTAL_BYTES: positiveInt(256 * MiB),
    IMAGE_MAX_INPUT_PIXELS: positiveInt(100_000_000),
    EXPORT_JOB_TIMEOUT_MS: positiveInt(30 * 60_000),
    RESTORE_MAX_ENTRIES: positiveInt(200_000),
    RESTORE_MAX_TOTAL_BYTES: positiveInt(50 * 1024 * MiB),
    /** Largest backup archive accepted for upload through the API (restores via the UI). */
    RESTORE_MAX_ARCHIVE_BYTES: positiveInt(5 * 1024 * MiB),

    WORKER_CONCURRENCY: positiveInt(2),
    WORKER_POLL_INTERVAL_MS: positiveInt(1_000),
    WORKER_SHUTDOWN_GRACE_MS: positiveInt(30_000),
    JOB_LEASE_SECONDS: positiveInt(120),
    /** Optional localhost-only liveness port for the worker (GET /healthz). */
    WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && !env.APP_ENV) {
      ctx.addIssue({
        code: "custom",
        path: ["APP_ENV"],
        message:
          "APP_ENV is required when NODE_ENV=production (production or staging for a deployment; " +
          "test or development only for local production builds)",
      });
    }
    const isProd = env.APP_ENV === "production" || env.APP_ENV === "staging";

    if (env.APP_ORIGIN === env.PREVIEW_ORIGIN) {
      ctx.addIssue({
        code: "custom",
        path: ["PREVIEW_ORIGIN"],
        message:
          "PREVIEW_ORIGIN must differ from APP_ORIGIN (untrusted content isolation, ADR-007)",
      });
    }

    const secrets = [
      env.BETTER_AUTH_SECRET,
      env.PREVIEW_TOKEN_SECRET,
      env.LOCAL_STORAGE_SIGNING_SECRET,
    ];
    if (new Set(secrets.filter(Boolean)).size !== secrets.filter(Boolean).length) {
      ctx.addIssue({
        code: "custom",
        path: ["PREVIEW_TOKEN_SECRET"],
        message: "secrets must be distinct values",
      });
    }

    if (env.STORAGE_DRIVER === "local") {
      if (!env.LOCAL_STORAGE_SIGNING_SECRET || env.LOCAL_STORAGE_SIGNING_SECRET.length < 32) {
        ctx.addIssue({
          code: "custom",
          path: ["LOCAL_STORAGE_SIGNING_SECRET"],
          message:
            "LOCAL_STORAGE_SIGNING_SECRET (≥ 32 chars) is required when STORAGE_DRIVER=local",
        });
      }
      if (isProd && !env.ALLOW_LOCAL_STORAGE_IN_PRODUCTION) {
        ctx.addIssue({
          code: "custom",
          path: ["STORAGE_DRIVER"],
          message:
            "local storage is refused in staging/production unless ALLOW_LOCAL_STORAGE_IN_PRODUCTION=true " +
            "and LOCAL_STORAGE_DIR is a persistent volume (ADR-006)",
        });
      }
    }

    if (env.STORAGE_DRIVER === "s3") {
      for (const key of [
        "S3_ENDPOINT",
        "S3_BUCKET",
        "S3_ACCESS_KEY_ID",
        "S3_SECRET_ACCESS_KEY",
      ] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is required when STORAGE_DRIVER=s3`,
          });
        }
      }
    }

    if (isProd) {
      for (const [key, value] of [
        ["APP_ORIGIN", env.APP_ORIGIN],
        ["PREVIEW_ORIGIN", env.PREVIEW_ORIGIN],
      ] as const) {
        if (!value.startsWith("https://")) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `${key} must use https in ${env.APP_ENV}`,
          });
        }
      }
    }
  })
  .transform((env) => ({ ...env, APP_ENV: env.APP_ENV ?? "development" }));

export type Env = z.infer<typeof EnvSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "EnvValidationError";
  }
}

/** Parses an environment record. Exported for tests; application code uses `getEnv()`. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }
  return result.data;
}

let cached: Env | undefined;

export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

/** Test hook: forget the cached environment so the next `getEnv()` re-reads process.env. */
export function resetEnvCache(): void {
  cached = undefined;
}
