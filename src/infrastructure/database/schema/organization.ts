import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, idColumn, updatedAt } from "./_shared";
import { artifacts } from "./library";
import { workspaces } from "./workspaces";

/**
 * Organization (docs/DATA_MODEL.md §4.4). A tag is a workspace-scoped label; its identity is
 * `normalized_name` (NFKC, trimmed, lower-case, collapsed whitespace), so two tags never
 * differ only in case, width or spacing. Collections come later.
 */

export const TAG_NAME_MAX_LENGTH = 50;

export const tags = pgTable(
  "tags",
  {
    id: idColumn(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("tags_workspace_normalized_name_unique").on(t.workspaceId, t.normalizedName),
    unique("tags_workspace_id_id_unique").on(t.workspaceId, t.id),
    // 50 = TAG_NAME_MAX_LENGTH (DDL cannot take a bind parameter).
    check("tags_name_length_check", sql`char_length(${t.name}) between 1 and 50`),
  ],
);

/**
 * Which artifacts carry which tags. The composite foreign keys include `workspace_id`, so the
 * database itself refuses a link between an artifact and a tag of different workspaces.
 */
export const artifactTags = pgTable(
  "artifact_tags",
  {
    workspaceId: uuid("workspace_id").notNull(),
    artifactId: uuid("artifact_id").notNull(),
    tagId: uuid("tag_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.artifactId, t.tagId] }),
    foreignKey({
      name: "artifact_tags_artifact_fk",
      columns: [t.workspaceId, t.artifactId],
      foreignColumns: [artifacts.workspaceId, artifacts.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "artifact_tags_tag_fk",
      columns: [t.workspaceId, t.tagId],
      foreignColumns: [tags.workspaceId, tags.id],
    }).onDelete("cascade"),
    index("artifact_tags_tag_idx").on(t.tagId),
  ],
);
