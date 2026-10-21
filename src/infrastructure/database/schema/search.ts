import {
  char,
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, idColumn } from "./_shared";
import { artifacts, artifactVersions, documentSections, extractedDocuments } from "./library";
import { workspaces } from "./workspaces";

/**
 * Keyword search (docs/SEARCH_DESIGN.md, DATA_MODEL.md §4.3). Vectors are written as
 * `tsvector` literals built by the application tokenizer (CJK bigrams + unigrams), never by
 * `to_tsvector`. All three tables are derived data: rebuilt from extractions and artifact rows.
 */
const tsvector = customType<{ data: string }>({
  dataType: () => "tsvector",
});

const workspaceRef = () =>
  uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });

/** Searchable text of one extraction, in chunks small enough for tsvector positions. */
export const contentChunks = pgTable(
  "content_chunks",
  {
    id: idColumn(),
    workspaceId: workspaceRef(),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    artifactVersionId: uuid("artifact_version_id")
      .notNull()
      .references(() => artifactVersions.id, { onDelete: "cascade" }),
    extractedDocumentId: uuid("extracted_document_id")
      .notNull()
      .references(() => extractedDocuments.id, { onDelete: "cascade" }),
    sectionId: uuid("section_id").references(() => documentSections.id, {
      onDelete: "set null",
    }),
    ordinal: integer("ordinal").notNull(),
    text: text("text").notNull(),
    charStart: integer("char_start").notNull(),
    charEnd: integer("char_end").notNull(),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    tokenizerVersion: integer("tokenizer_version").notNull(),
    searchVector: tsvector("search_vector").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("content_chunks_search_idx").using("gin", t.searchVector),
    index("content_chunks_workspace_artifact_idx").on(t.workspaceId, t.artifactId),
    index("content_chunks_version_idx").on(t.artifactVersionId),
  ],
);

/** Artifact-level metadata: title (A), description/summary (B), source info (C). */
export const artifactSearchDocuments = pgTable(
  "artifact_search_documents",
  {
    artifactId: uuid("artifact_id")
      .primaryKey()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    workspaceId: workspaceRef(),
    searchVector: tsvector("search_vector").notNull(),
    tokenizerVersion: integer("tokenizer_version").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("artifact_search_documents_search_idx").using("gin", t.searchVector),
    index("artifact_search_documents_workspace_idx").on(t.workspaceId),
  ],
);

/**
 * What a version's chunks were last built from. Written in the same transaction as the
 * chunks, also when the text is empty and there are no chunks, so the backfill can tell
 * "indexed, nothing to index" from "never indexed" without guessing from the text.
 */
export const searchIndexStates = pgTable("search_index_states", {
  artifactVersionId: uuid("artifact_version_id")
    .primaryKey()
    .references(() => artifactVersions.id, { onDelete: "cascade" }),
  workspaceId: workspaceRef(),
  extractedDocumentId: uuid("extracted_document_id").references(() => extractedDocuments.id, {
    onDelete: "set null",
  }),
  tokenizerVersion: integer("tokenizer_version").notNull(),
  chunkCount: integer("chunk_count").notNull(),
  indexedAt: timestamp("indexed_at", { withTimezone: true }).notNull().defaultNow(),
});
