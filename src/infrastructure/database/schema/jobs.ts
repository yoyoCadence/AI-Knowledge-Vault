import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createdAt, idColumn, oneOf, updatedAt } from "./_shared";
import { workspaces } from "./workspaces";

export const JOB_STATUSES = ["queued", "running", "completed", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export type JobProgress = { current: number; total: number; message?: string };

/** Durable job queue with leases (ADR-005, ARCHITECTURE.md §7). */
export const processingJobs = pgTable(
  "processing_jobs",
  {
    id: idColumn(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").$type<JobStatus>().notNull().default("queued"),
    priority: integer("priority").notNull().default(0),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lockedBy: text("locked_by"),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    progress: jsonb("progress").$type<JobProgress>(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    lastError: text("last_error"),
    errorCode: text("error_code"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    check("processing_jobs_status_check", oneOf(t.status, JOB_STATUSES)),
    check("processing_jobs_attempts_check", sql`${t.attemptCount} >= 0 and ${t.maxAttempts} >= 1`),
    index("processing_jobs_claim_idx")
      .on(t.priority.desc(), t.runAfter)
      .where(sql`${t.status} = 'queued'`),
    index("processing_jobs_lease_idx").on(t.status, t.lockedUntil),
    index("processing_jobs_workspace_type_idx").on(t.workspaceId, t.type, t.createdAt.desc()),
  ],
);
