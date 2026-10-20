import { and, desc, eq, gt, ne } from "drizzle-orm";
import type { DbExecutor } from "@/infrastructure/database/client";
import { sessions } from "@/infrastructure/database/schema";
import { recordAudit, type RequestMeta } from "@/modules/audit";
import type { Actor } from "./actor";

/** Session summary safe to send to the browser: never includes the session token. */
export interface SessionSummary {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  current: boolean;
}

export async function listActiveSessions(db: DbExecutor, actor: Actor): Promise<SessionSummary[]> {
  const rows = await db
    .select({
      id: sessions.id,
      createdAt: sessions.createdAt,
      expiresAt: sessions.expiresAt,
      ipAddress: sessions.ipAddress,
      userAgent: sessions.userAgent,
    })
    .from(sessions)
    .where(and(eq(sessions.userId, actor.userId), gt(sessions.expiresAt, new Date())))
    .orderBy(desc(sessions.createdAt));
  return rows.map((row) => ({ ...row, current: row.id === actor.sessionId }));
}

/** Revokes one of the actor's own sessions. Returns false if it does not exist / is not theirs. */
export async function revokeSession(
  db: DbExecutor,
  actor: Actor,
  sessionId: string,
  meta: RequestMeta,
): Promise<boolean> {
  const deleted = await db
    .delete(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, actor.userId)))
    .returning({ id: sessions.id });
  if (deleted.length === 0) return false;
  await recordAudit(db, {
    action: "auth.session.revoked",
    workspaceId: actor.workspaceId,
    actorUserId: actor.userId,
    targetType: "session",
    targetId: sessionId,
    ...meta,
  });
  return true;
}

/** Revokes all of the actor's sessions except the current one. Returns the number revoked. */
export async function revokeOtherSessions(
  db: DbExecutor,
  actor: Actor,
  meta: RequestMeta,
): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(and(eq(sessions.userId, actor.userId), ne(sessions.id, actor.sessionId)))
    .returning({ id: sessions.id });
  await recordAudit(db, {
    action: "auth.session.revoked_others",
    workspaceId: actor.workspaceId,
    actorUserId: actor.userId,
    metadata: { count: deleted.length },
    ...meta,
  });
  return deleted.length;
}
