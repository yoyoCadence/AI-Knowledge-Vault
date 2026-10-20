import { index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, idColumn } from "./_shared";
import { users } from "./auth";
import { workspaces } from "./workspaces";

/** Append-only security/audit trail (docs/SECURITY.md, ARCHITECTURE.md §6). */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: idColumn(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_logs_workspace_created_idx").on(t.workspaceId, t.createdAt.desc()),
    index("audit_logs_action_created_idx").on(t.action, t.createdAt.desc()),
  ],
);
