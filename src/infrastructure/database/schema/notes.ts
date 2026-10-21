import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, idColumn, oneOf, updatedAt } from "./_shared";
import { users } from "./auth";
import { artifacts } from "./library";

/**
 * Notes and reading state (docs/DATA_MODEL.md §4.4). Both reference the artifact through the
 * composite `(workspace_id, artifact_id)` key, as tag links do, so the database itself refuses
 * a note or a state that crosses workspaces, and both go with the artifact.
 */

export const READING_STATUSES = ["unread", "reading", "read"] as const;
export type ReadingStatus = (typeof READING_STATUSES)[number];
export const NOTE_MAX_LENGTH = 20_000;

/** A Markdown note on an artifact. The author is kept for display; notes outlive their author. */
export const artifactNotes = pgTable(
  "artifact_notes",
  {
    id: idColumn(),
    workspaceId: uuid("workspace_id").notNull(),
    artifactId: uuid("artifact_id").notNull(),
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    bodyMarkdown: text("body_markdown").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // 20,000 = NOTE_MAX_LENGTH (DDL cannot take a bind parameter).
    check(
      "artifact_notes_body_length_check",
      sql`char_length(${t.bodyMarkdown}) between 1 and 20000`,
    ),
    foreignKey({
      name: "artifact_notes_artifact_fk",
      columns: [t.workspaceId, t.artifactId],
      foreignColumns: [artifacts.workspaceId, artifacts.id],
    }).onDelete("cascade"),
    index("artifact_notes_artifact_idx").on(t.artifactId, t.createdAt),
  ],
);

/**
 * One user's reading state of one artifact. No row means unread, not a favorite, never opened;
 * a row is written on the first change.
 */
export const artifactReadingStates = pgTable(
  "artifact_reading_states",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    artifactId: uuid("artifact_id").notNull(),
    status: text("status").$type<ReadingStatus>().notNull().default("unread"),
    isFavorite: boolean("is_favorite").notNull().default(false),
    lastOpenedAt: timestamp("last_opened_at", { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.artifactId] }),
    check("artifact_reading_states_status_check", oneOf(t.status, READING_STATUSES)),
    foreignKey({
      name: "artifact_reading_states_artifact_fk",
      columns: [t.workspaceId, t.artifactId],
      foreignColumns: [artifacts.workspaceId, artifacts.id],
    }).onDelete("cascade"),
    // "Recently opened" is a keyset scan of one user's states.
    index("artifact_reading_states_recent_idx").on(t.userId, t.lastOpenedAt, t.artifactId),
    index("artifact_reading_states_artifact_idx").on(t.artifactId),
  ],
);
