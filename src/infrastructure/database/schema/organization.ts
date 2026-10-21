import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, idColumn, oneOf, updatedAt } from "./_shared";
import { artifacts } from "./library";
import { workspaces } from "./workspaces";

/**
 * Organization (docs/DATA_MODEL.md §4.4). A tag is a workspace-scoped label; its identity is
 * `normalized_name` (NFKC, trimmed, lower-case, collapsed whitespace), so two tags never
 * differ only in case, width or spacing. Collections group artifacts in a tree; an artifact
 * can be in many collections.
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

export const COLLECTION_KINDS = ["category", "collection"] as const;
export const COLLECTION_NAME_MAX_LENGTH = 100;
/** Levels below the root a collection may sit (keeps the tree and its queries shallow). */
export const COLLECTION_MAX_DEPTH = 6;

/**
 * Collections (FR-LIB-5): categories (a classification tree) and custom collections, both
 * able to nest and to hold artifacts. Names are unique among siblings by their normalized
 * form (as tags). The tree never has cycles: moves are checked in code under a lock.
 */
export const collections = pgTable(
  "collections",
  {
    id: idColumn(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"),
    kind: text("kind").$type<(typeof COLLECTION_KINDS)[number]>().notNull().default("collection"),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    description: text("description"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("collections_kind_check", oneOf(t.kind, COLLECTION_KINDS)),
    // 100 = COLLECTION_NAME_MAX_LENGTH (DDL cannot take a bind parameter).
    check("collections_name_length_check", sql`char_length(${t.name}) between 1 and 100`),
    check("collections_not_own_parent_check", sql`${t.parentId} is distinct from ${t.id}`),
    unique("collections_workspace_id_id_unique").on(t.workspaceId, t.id),
    unique("collections_sibling_name_unique")
      .on(t.workspaceId, t.parentId, t.normalizedName)
      .nullsNotDistinct(),
    // The parent is in the same workspace; deleting a parent with children is refused in
    // code, and the database refuses it too (no cascade).
    foreignKey({
      name: "collections_parent_fk",
      columns: [t.workspaceId, t.parentId],
      foreignColumns: [t.workspaceId, t.id],
    }),
    index("collections_parent_idx").on(t.parentId),
  ],
);

/** Which artifacts a collection holds, in the order they were added. */
export const collectionItems = pgTable(
  "collection_items",
  {
    workspaceId: uuid("workspace_id").notNull(),
    collectionId: uuid("collection_id").notNull(),
    artifactId: uuid("artifact_id").notNull(),
    position: integer("position").notNull().default(0),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.collectionId, t.artifactId] }),
    foreignKey({
      name: "collection_items_collection_fk",
      columns: [t.workspaceId, t.collectionId],
      foreignColumns: [collections.workspaceId, collections.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "collection_items_artifact_fk",
      columns: [t.workspaceId, t.artifactId],
      foreignColumns: [artifacts.workspaceId, artifacts.id],
    }).onDelete("cascade"),
    index("collection_items_artifact_idx").on(t.artifactId),
  ],
);
