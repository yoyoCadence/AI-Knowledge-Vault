import { getEnv } from "@/infrastructure/config/env";
import { getDb } from "@/infrastructure/database/client";
import { resolveActor, type Actor } from "./actor";
import { createAuth, type Auth } from "./auth";

export {
  createAuth,
  hashEmailForAudit,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  type Auth,
} from "./auth";
export { rateLimitAddress, resolveClientIp } from "./client-ip";
export { resolveActor, assertCan, requireActorOrThrow, type Actor } from "./actor";
export { roleAllows, ACTIONS, type Action } from "./policy";
export { createAdmin, AdminInput, slugify } from "./admin";
export {
  listActiveSessions,
  revokeSession,
  revokeOtherSessions,
  type SessionSummary,
} from "./sessions";

const globalForAuth = globalThis as unknown as { __vaultAuth?: Auth };

/** Process-wide Better Auth instance. */
export function getAuth(): Auth {
  globalForAuth.__vaultAuth ??= createAuth(getDb(), getEnv());
  return globalForAuth.__vaultAuth;
}

/** Resolves the current actor from request headers using the process-wide auth instance. */
export function getActor(headers: Headers): Promise<Actor | null> {
  return resolveActor(getAuth(), getDb(), headers);
}
