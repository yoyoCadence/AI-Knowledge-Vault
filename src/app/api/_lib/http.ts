import { type z } from "zod";
import { getEnv } from "@/infrastructure/config/env";
import { getLogger } from "@/infrastructure/observability/logger";
import { AppError, isAppError } from "@/lib/errors";
import { newErrorId } from "@/lib/ids";
import { resolveClientIp } from "@/modules/auth";

/**
 * Route-handler plumbing shared by every /api endpoint (docs/API_CONTRACT.md §1).
 * Uses only Web-standard Request/Response so it stays framework-agnostic.
 */

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function errorResponse(error: unknown, context: Record<string, unknown> = {}): Response {
  if (isAppError(error)) {
    const errorId = error.status >= 500 ? newErrorId() : undefined;
    if (errorId)
      getLogger(context).error({ err: error, errorId, code: error.code }, "request failed");
    return json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(errorId ? { errorId } : {}),
          ...(error.details ? { details: error.details } : {}),
        },
      },
      { status: error.status },
    );
  }
  const errorId = newErrorId();
  getLogger(context).error({ err: error, errorId }, "unhandled request error");
  return json(
    { error: { code: "INTERNAL_ERROR", message: "Internal error", errorId } },
    { status: 500 },
  );
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CSRF defense for cookie-authenticated mutations (docs/SECURITY.md §8): the Origin must be the
 * app origin; without Origin, Fetch Metadata must say same-origin.
 */
export function assertSameOrigin(request: Request): void {
  if (!MUTATING.has(request.method)) return;
  const origin = request.headers.get("origin");
  if (origin) {
    if (origin !== getEnv().APP_ORIGIN)
      throw new AppError("CSRF_REJECTED", "Cross-origin request rejected");
    return;
  }
  if (request.headers.get("sec-fetch-site") !== "same-origin") {
    throw new AppError("CSRF_REJECTED", "Cross-origin request rejected");
  }
}

/** Parses a JSON body with a Zod schema; rejects non-JSON content types. */
export async function parseJsonBody<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<z.infer<T>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new AppError("UNSUPPORTED_MEDIA_TYPE", "Expected application/json");
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new AppError("VALIDATION_FAILED", "Malformed JSON body");
  }
  return validate(schema, raw);
}

export function parseQuery<T extends z.ZodType>(request: Request, schema: T): z.infer<T> {
  const params = Object.fromEntries(new URL(request.url).searchParams.entries());
  return validate(schema, params);
}

/** Checks a parsed body against `schema`; failures name paths, never submitted values. */
export function validate<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError("VALIDATION_FAILED", "Request validation failed", {
      // Paths and messages only — never echo submitted values.
      details: {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    });
  }
  return result.data;
}

export function requestMeta(request: Request): {
  ipAddress: string | null;
  userAgent: string | null;
} {
  return {
    ipAddress: resolveClientIp(request.headers, getEnv().TRUSTED_PROXIES),
    userAgent: request.headers.get("user-agent"),
  };
}
