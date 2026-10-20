import { createHash } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware } from "better-auth/api";
import type { Env } from "@/infrastructure/config/env";
import type { Database } from "@/infrastructure/database/client";
import {
  authAccounts,
  authRateLimits,
  authVerifications,
  sessions,
  users,
} from "@/infrastructure/database/schema";
import { getLogger } from "@/infrastructure/observability/logger";
import { newId } from "@/lib/ids";
import { recordAudit } from "@/modules/audit";
import { resolveClientIp } from "./client-ip";

/**
 * Better Auth configuration (ADR-004, docs/SECURITY.md §6).
 *
 * - Email + password only; public sign-up disabled (admins are created by `pnpm admin:create`).
 * - Sessions and rate-limit counters live in PostgreSQL (multi-instance safe, F-10).
 * - Telemetry disabled (F-11).
 * - Endpoints we do not use are disabled outright rather than left reachable.
 */

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

const DISABLED_PATHS = [
  "/sign-up/email",
  "/change-email",
  "/delete-user",
  "/delete-user/callback",
  "/request-password-reset",
  "/reset-password",
  "/verify-email",
  "/send-verification-email",
  "/link-social",
  "/unlink-account",
  "/list-accounts",
  "/sign-in/social",
  // Session endpoints serialize session tokens and bypass our audited /api/sessions facade.
  // Server code calls auth.api.getSession() directly, which disabledPaths does not affect.
  "/get-session",
  "/list-sessions",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
];

/** One-way, non-reversible identifier for audit records of failed logins (no raw emails). */
export function hashEmailForAudit(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 16);
}

export function createAuth(
  db: Database,
  env: Pick<Env, "APP_ORIGIN" | "BETTER_AUTH_SECRET" | "APP_ENV" | "TRUSTED_PROXIES">,
) {
  const isProduction = env.APP_ENV === "production" || env.APP_ENV === "staging";

  return betterAuth({
    appName: "AI Knowledge Vault",
    baseURL: env.APP_ORIGIN,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.APP_ORIGIN],
    database: drizzleAdapter(db, {
      provider: "pg",
      // Keys are Better Auth model names; values are our tables (names mapped in the schema).
      schema: {
        user: users,
        session: sessions,
        account: authAccounts,
        verification: authVerifications,
        rateLimit: authRateLimits,
      },
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 30,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
      },
    },
    disabledPaths: DISABLED_PATHS,
    telemetry: { enabled: false },
    advanced: {
      cookiePrefix: "vault",
      useSecureCookies: isProduction,
      ...(env.TRUSTED_PROXIES.length > 0
        ? { ipAddress: { trustedProxies: env.TRUSTED_PROXIES } }
        : {}),
      database: { generateId: () => newId() },
    },
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-in/email" && ctx.path !== "/sign-out") return;
        const headers = ctx.headers ?? new Headers();
        const meta = {
          // Same resolver as the rate limiter: honours TRUSTED_PROXIES, so a client-supplied
          // X-Forwarded-For entry cannot choose the audited address.
          ipAddress: resolveClientIp(headers, env.TRUSTED_PROXIES),
          userAgent: headers.get("user-agent"),
        };
        try {
          if (ctx.path === "/sign-in/email") {
            const newSession = ctx.context.newSession;
            if (newSession) {
              await recordAudit(db, {
                action: "auth.login.succeeded",
                actorUserId: newSession.user.id,
                ...meta,
              });
            } else {
              const email = typeof ctx.body?.email === "string" ? ctx.body.email : "";
              await recordAudit(db, {
                action: "auth.login.failed",
                metadata: { emailHash: hashEmailForAudit(email) },
                ...meta,
              });
            }
          } else {
            await recordAudit(db, {
              action: "auth.logout",
              actorUserId: ctx.context.session?.user.id ?? null,
              ...meta,
            });
          }
        } catch (error) {
          // Auditing must never break authentication; the failure itself is logged.
          getLogger({ component: "auth" }).error(
            { err: error },
            "failed to record auth audit event",
          );
        }
      }),
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
