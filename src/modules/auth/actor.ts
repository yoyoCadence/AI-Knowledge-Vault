import { asc, eq } from "drizzle-orm";
import type { Database } from "@/infrastructure/database/client";
import { workspaceMembers, type WorkspaceRole } from "@/infrastructure/database/schema";
import { AppError } from "@/lib/errors";
import type { Auth } from "./auth";
import { roleAllows, type Action } from "./policy";

/**
 * The authenticated principal every domain service receives (ARCHITECTURE.md §2 rule 4).
 * All user-data queries are scoped by `workspaceId`.
 */
export interface Actor {
  userId: string;
  workspaceId: string;
  role: WorkspaceRole;
  sessionId: string;
  email: string;
  name: string;
}

/** Resolves the actor from request headers (session cookie). Returns null when anonymous. */
export async function resolveActor(
  auth: Auth,
  db: Database,
  headers: Headers,
): Promise<Actor | null> {
  const session = await auth.api.getSession({ headers });
  if (!session) return null;
  // Phase 1: one workspace per user (the one created by admin:create). Multi-workspace
  // selection is a future extension; the earliest membership is the default.
  const [membership] = await db
    .select({ workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, session.user.id))
    .orderBy(asc(workspaceMembers.createdAt))
    .limit(1);
  if (!membership) return null;
  return {
    userId: session.user.id,
    workspaceId: membership.workspaceId,
    role: membership.role,
    sessionId: session.session.id,
    email: session.user.email,
    name: session.user.name,
  };
}

export function assertCan(actor: Actor, action: Action): void {
  if (!roleAllows(actor.role, action)) {
    throw new AppError("FORBIDDEN", "You do not have permission to perform this action");
  }
}

export function requireActorOrThrow(actor: Actor | null): Actor {
  if (!actor) throw new AppError("UNAUTHENTICATED", "Authentication required");
  return actor;
}
