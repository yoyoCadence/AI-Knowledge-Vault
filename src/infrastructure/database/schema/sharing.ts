import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, idColumn, updatedAt } from "./_shared";
import { users } from "./auth";
import { artifacts } from "./library";

/**
 * Share links (docs/DATA_MODEL.md §4.1, docs/SECURITY.md §7, FR-SHR). Only the SHA-256 of a
 * link's token is stored: the token itself is shown once, when the link is created, and is
 * never exported. A link reads one artifact, with the permissions it was created with, until it
 * expires, is revoked, or the artifact is made private again or deleted.
 */
export const shareLinks = pgTable(
  "share_links",
  {
    id: idColumn(),
    workspaceId: uuid("workspace_id").notNull(),
    artifactId: uuid("artifact_id").notNull(),
    tokenHash: char("token_hash", { length: 64 }).notNull().unique(),
    label: text("label"),
    allowPreview: boolean("allow_preview").notNull().default(true),
    allowReading: boolean("allow_reading").notNull().default(true),
    allowDownload: boolean("allow_download").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
    accessCount: integer("access_count").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "share_links_some_permission_check",
      sql`${t.allowPreview} or ${t.allowReading} or ${t.allowDownload}`,
    ),
    check("share_links_label_length_check", sql`char_length(${t.label}) <= 100`),
    foreignKey({
      name: "share_links_artifact_fk",
      columns: [t.workspaceId, t.artifactId],
      foreignColumns: [artifacts.workspaceId, artifacts.id],
    }).onDelete("cascade"),
    index("share_links_artifact_idx").on(t.artifactId, t.createdAt),
  ],
);

/**
 * Fixed-window request counters for anonymous routes (share links), keyed by purpose and
 * client address. Rows are tiny and rewritten in place; old windows are simply overwritten.
 */
export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    key: text("key").primaryKey(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull(),
  },
  // The hourly cleanup deletes by window start; rows can pile up when many addresses call.
  (t) => [index("rate_limit_buckets_window_idx").on(t.windowStart)],
);
