import type { DbExecutor } from "@/infrastructure/database/client";
import { auditLogs } from "@/infrastructure/database/schema";

/**
 * Append-only audit trail (docs/SECURITY.md §2 "Repudiation").
 * Never put secrets, tokens, passwords, or document content in `metadata`.
 */
export interface AuditEvent {
  action: string;
  workspaceId?: string | null;
  actorUserId?: string | null;
  targetType?: string;
  targetId?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

export interface RequestMeta {
  ipAddress: string | null;
  userAgent: string | null;
}

export async function recordAudit(db: DbExecutor, event: AuditEvent): Promise<void> {
  await db.insert(auditLogs).values({
    action: event.action,
    workspaceId: event.workspaceId ?? null,
    actorUserId: event.actorUserId ?? null,
    targetType: event.targetType ?? null,
    targetId: event.targetId ?? null,
    ipAddress: event.ipAddress ?? null,
    userAgent: event.userAgent?.slice(0, 512) ?? null,
    metadata: event.metadata ?? {},
  });
}
