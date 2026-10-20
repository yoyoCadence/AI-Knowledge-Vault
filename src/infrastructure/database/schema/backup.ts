import { sql } from "drizzle-orm";
import {
  bigint,
  char,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, idColumn, oneOf } from "./_shared";
import { users } from "./auth";
import { processingJobs } from "./jobs";
import { workspaces } from "./workspaces";

/** Backup bookkeeping (docs/BACKUP_RECOVERY.md, DATA_MODEL.md §4). */

export const RUN_STATUSES = ["queued", "running", "completed", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const RESTORE_MODES = ["skip_existing", "copy"] as const;
export type RestoreMode = (typeof RESTORE_MODES)[number];

const workspaceRef = () =>
  uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });
const requestedBy = () => uuid("requested_by").references(() => users.id, { onDelete: "set null" });
const jobRef = () => uuid("job_id").references(() => processingJobs.id, { onDelete: "set null" });

export const exportRuns = pgTable(
  "export_runs",
  {
    id: idColumn(),
    workspaceId: workspaceRef(),
    requestedBy: requestedBy(),
    status: text("status").$type<RunStatus>().notNull().default("queued"),
    formatVersion: integer("format_version").notNull(),
    options: jsonb("options").$type<Record<string, unknown>>().notNull().default({}),
    storageKey: text("storage_key"),
    filename: text("filename"),
    byteSize: bigint("byte_size", { mode: "number" }),
    sha256: char("sha256", { length: 64 }),
    manifestSummary: jsonb("manifest_summary").$type<Record<string, unknown>>(),
    errorMessage: text("error_message"),
    jobId: jobRef(),
    createdAt: createdAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [
    check("export_runs_status_check", oneOf(t.status, RUN_STATUSES)),
    index("export_runs_workspace_created_idx").on(t.workspaceId, t.createdAt.desc()),
  ],
);

export const restoreRuns = pgTable(
  "restore_runs",
  {
    id: idColumn(),
    workspaceId: workspaceRef(),
    requestedBy: requestedBy(),
    status: text("status").$type<RunStatus>().notNull().default("queued"),
    sourceStorageKey: text("source_storage_key"),
    sourceFilename: text("source_filename"),
    sourceByteSize: bigint("source_byte_size", { mode: "number" }),
    sourceSha256: char("source_sha256", { length: 64 }),
    mode: text("mode").$type<RestoreMode>().notNull().default("skip_existing"),
    report: jsonb("report").$type<Record<string, unknown>>(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    jobId: jobRef(),
    createdAt: createdAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    check("restore_runs_status_check", oneOf(t.status, RUN_STATUSES)),
    check("restore_runs_mode_check", oneOf(t.mode, RESTORE_MODES)),
    index("restore_runs_workspace_created_idx").on(t.workspaceId, t.createdAt.desc()),
  ],
);

export const integrityChecks = pgTable(
  "integrity_checks",
  {
    id: idColumn(),
    workspaceId: workspaceRef(),
    status: text("status").$type<RunStatus>().notNull().default("running"),
    checkedCount: integer("checked_count").notNull().default(0),
    okCount: integer("ok_count").notNull().default(0),
    missingCount: integer("missing_count").notNull().default(0),
    corruptCount: integer("corrupt_count").notNull().default(0),
    report: jsonb("report").$type<Record<string, unknown>>().notNull().default({}),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    check("integrity_checks_status_check", oneOf(t.status, RUN_STATUSES)),
    check(
      "integrity_checks_counts_check",
      sql`${t.checkedCount} >= 0 and ${t.okCount} >= 0 and ${t.missingCount} >= 0 and ${t.corruptCount} >= 0`,
    ),
    index("integrity_checks_workspace_started_idx").on(t.workspaceId, t.startedAt.desc()),
  ],
);
