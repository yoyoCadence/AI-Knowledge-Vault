import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, idColumn, oneOf, updatedAt } from "./_shared";
import { users } from "./auth";
import { collections } from "./organization";
import { workspaces } from "./workspaces";

/**
 * Library core + import processing (docs/DATA_MODEL.md §4.2–4.3).
 * Kept in one module because these tables reference each other in cycles
 * (artifact ⇄ current version, version ⇄ active extraction, version ⇄ import item).
 */

// ---------- enums (text + CHECK, DATA_MODEL §1 rule 9) ----------
export const PROJECT_STATUSES = ["active", "archived"] as const;
export const VISIBILITIES = ["private", "unlisted", "public"] as const;
export const SENSITIVITIES = ["normal", "sensitive", "restricted"] as const;
export const REVIEW_STATUSES = ["unreviewed", "reviewed", "verified", "disputed"] as const;
export const CONTENT_KINDS = [
  "html_document",
  "claude_design_document",
  "static_site",
  "framework_project",
  "pdf",
  "markdown",
  "text",
  "image",
  "archive_other",
  "unknown",
] as const;
export const PREVIEW_KINDS = [
  "static_html",
  "static_site",
  "framework_source",
  "unsupported",
  "pdf",
  "image",
  "text_only",
] as const;
export const PREVIEW_STATUSES = ["pending", "ready", "unavailable", "failed"] as const;
export const PROCESSING_STATUSES = ["pending", "processing", "ready", "failed"] as const;
export const STORAGE_PROVIDERS = ["local", "s3"] as const;
export const FILE_STORAGE_STATUSES = ["stored", "missing", "corrupt"] as const;
export const ARTIFACT_FILE_ROLES = ["original", "attachment", "cover"] as const;
export const DERIVED_KINDS = ["preview_file", "thumbnail"] as const;
export const EXTRACTION_STATUSES = ["succeeded", "partial", "failed"] as const;
export const BATCH_STATUSES = [
  "open",
  "processing",
  "completed",
  "completed_with_errors",
  "cancelled",
] as const;
export const ITEM_STATUSES = [
  "awaiting_upload",
  "uploaded",
  "queued",
  "processing",
  "succeeded",
  "duplicate",
  "failed",
  "cancelled",
  "expired",
] as const;
export const ITEM_OUTCOMES = ["new_artifact", "new_version", "duplicate_file"] as const;
export const MATCH_REASONS = ["explicit_target", "filename_stem", "same_hash"] as const;

export type Visibility = (typeof VISIBILITIES)[number];
export type Sensitivity = (typeof SENSITIVITIES)[number];
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export type ContentKind = (typeof CONTENT_KINDS)[number];
export type PreviewKind = (typeof PREVIEW_KINDS)[number];
export type PreviewStatus = (typeof PREVIEW_STATUSES)[number];
export type ProcessingStatus = (typeof PROCESSING_STATUSES)[number];
export type StorageProviderName = (typeof STORAGE_PROVIDERS)[number];
export type FileStorageStatus = (typeof FILE_STORAGE_STATUSES)[number];
export type ArtifactFileRole = (typeof ARTIFACT_FILE_ROLES)[number];
export type DerivedKind = (typeof DERIVED_KINDS)[number];
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];
export type BatchStatus = (typeof BATCH_STATUSES)[number];
export type ItemStatus = (typeof ITEM_STATUSES)[number];
export type ItemOutcome = (typeof ITEM_OUTCOMES)[number];
export type MatchReason = (typeof MATCH_REASONS)[number];

export interface ReferenceSource {
  title?: string;
  url: string;
}

const workspaceRef = () =>
  uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });
const createdBy = () => uuid("created_by").references(() => users.id, { onDelete: "set null" });
const sha256Column = (name: string) => char(name, { length: 64 });

// ---------- research projects ----------
export const researchProjects = pgTable(
  "research_projects",
  {
    id: idColumn(),
    workspaceId: workspaceRef(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").$type<(typeof PROJECT_STATUSES)[number]>().notNull().default("active"),
    createdBy: createdBy(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    check("research_projects_status_check", oneOf(t.status, PROJECT_STATUSES)),
    index("research_projects_workspace_title_idx").on(t.workspaceId, t.title),
  ],
);

// ---------- artifacts ----------
export const artifacts = pgTable(
  "artifacts",
  {
    id: idColumn(),
    workspaceId: workspaceRef(),
    projectId: uuid("project_id").references(() => researchProjects.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description"),
    summary: text("summary"),
    visibility: text("visibility").$type<Visibility>().notNull().default("private"),
    sensitivity: text("sensitivity").$type<Sensitivity>().notNull().default("normal"),
    reviewStatus: text("review_status").$type<ReviewStatus>().notNull().default("unreviewed"),
    identityKey: text("identity_key"),
    currentVersionId: uuid("current_version_id").references(
      (): AnyPgColumn => artifactVersions.id,
      {
        onDelete: "set null",
      },
    ),
    originRef: text("origin_ref"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdBy: createdBy(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    check("artifacts_visibility_check", oneOf(t.visibility, VISIBILITIES)),
    check("artifacts_sensitivity_check", oneOf(t.sensitivity, SENSITIVITIES)),
    check("artifacts_review_status_check", oneOf(t.reviewStatus, REVIEW_STATUSES)),
    index("artifacts_workspace_listing_idx").on(t.workspaceId, t.deletedAt, t.createdAt.desc()),
    index("artifacts_workspace_identity_idx").on(t.workspaceId, t.identityKey),
    index("artifacts_workspace_project_idx").on(t.workspaceId, t.projectId),
    // Target of workspace-scoped composite foreign keys (artifact_tags): a link row can only
    // pair an artifact and a tag of the same workspace.
    unique("artifacts_workspace_id_id_unique").on(t.workspaceId, t.id),
  ],
);

// ---------- file assets (immutable originals; trigger in migration 0002) ----------
export const fileAssets = pgTable(
  "file_assets",
  {
    id: idColumn(),
    workspaceId: workspaceRef(),
    storageProvider: text("storage_provider").$type<StorageProviderName>().notNull(),
    storageKey: text("storage_key").notNull().unique(),
    originalFilename: text("original_filename").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    sha256: sha256Column("sha256").notNull(),
    storageStatus: text("storage_status").$type<FileStorageStatus>().notNull().default("stored"),
    integrityVerifiedAt: timestamp("integrity_verified_at", { withTimezone: true }),
    createdBy: createdBy(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("file_assets_workspace_sha256_unique").on(t.workspaceId, t.sha256),
    check("file_assets_storage_provider_check", oneOf(t.storageProvider, STORAGE_PROVIDERS)),
    check("file_assets_storage_status_check", oneOf(t.storageStatus, FILE_STORAGE_STATUSES)),
    check("file_assets_byte_size_check", sql`${t.byteSize} >= 0`),
    check("file_assets_sha256_format_check", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

// ---------- artifact versions ----------
export const artifactVersions = pgTable(
  "artifact_versions",
  {
    id: idColumn(),
    workspaceId: workspaceRef(),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    primaryFileId: uuid("primary_file_id")
      .notNull()
      // NO ACTION (checked at statement end): refuses deleting a referenced original, while
      // still allowing a whole-workspace cascade delete (RESTRICT would fail mid-cascade).
      .references(() => fileAssets.id, { onDelete: "no action" }),
    contentKind: text("content_kind").$type<ContentKind>().notNull(),
    previewKind: text("preview_kind").$type<PreviewKind>().notNull(),
    previewStatus: text("preview_status").$type<PreviewStatus>().notNull().default("pending"),
    previewEntryPath: text("preview_entry_path"),
    processingStatus: text("processing_status")
      .$type<ProcessingStatus>()
      .notNull()
      .default("pending"),
    activeExtractionId: uuid("active_extraction_id").references(
      (): AnyPgColumn => extractedDocuments.id,
      {
        onDelete: "set null",
      },
    ),
    contentHash: sha256Column("content_hash"),
    sourcePlatform: text("source_platform"),
    sourceModel: text("source_model"),
    originalPrompt: text("original_prompt"),
    sourceUrl: text("source_url"),
    researchDate: date("research_date", { mode: "string" }),
    author: text("author"),
    referenceSources: jsonb("reference_sources").$type<ReferenceSource[]>().notNull().default([]),
    changeSummary: text("change_summary"),
    analysis: jsonb("analysis").$type<Record<string, unknown>>().notNull().default({}),
    importItemId: uuid("import_item_id").references((): AnyPgColumn => importItems.id, {
      onDelete: "set null",
    }),
    createdBy: createdBy(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("artifact_versions_artifact_number_unique").on(t.artifactId, t.versionNumber),
    check("artifact_versions_number_check", sql`${t.versionNumber} >= 1`),
    check("artifact_versions_content_kind_check", oneOf(t.contentKind, CONTENT_KINDS)),
    check("artifact_versions_preview_kind_check", oneOf(t.previewKind, PREVIEW_KINDS)),
    check("artifact_versions_preview_status_check", oneOf(t.previewStatus, PREVIEW_STATUSES)),
    check(
      "artifact_versions_processing_status_check",
      oneOf(t.processingStatus, PROCESSING_STATUSES),
    ),
    index("artifact_versions_workspace_content_hash_idx").on(t.workspaceId, t.contentHash),
    index("artifact_versions_primary_file_idx").on(t.primaryFileId),
  ],
);

// ---------- version ↔ file links ----------
export const artifactFiles = pgTable(
  "artifact_files",
  {
    id: idColumn(),
    artifactVersionId: uuid("artifact_version_id")
      .notNull()
      .references(() => artifactVersions.id, { onDelete: "cascade" }),
    fileAssetId: uuid("file_asset_id")
      .notNull()
      .references(() => fileAssets.id, { onDelete: "no action" }),
    role: text("role").$type<ArtifactFileRole>().notNull(),
    displayName: text("display_name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("artifact_files_version_asset_role_unique").on(
      t.artifactVersionId,
      t.fileAssetId,
      t.role,
    ),
    check("artifact_files_role_check", oneOf(t.role, ARTIFACT_FILE_ROLES)),
    index("artifact_files_file_asset_idx").on(t.fileAssetId),
  ],
);

// ---------- derived (regenerable) assets ----------
export const derivedAssets = pgTable(
  "derived_assets",
  {
    id: idColumn(),
    workspaceId: workspaceRef(),
    artifactVersionId: uuid("artifact_version_id")
      .notNull()
      .references(() => artifactVersions.id, { onDelete: "cascade" }),
    kind: text("kind").$type<DerivedKind>().notNull(),
    path: text("path").notNull().default(""),
    storageKey: text("storage_key").notNull().unique(),
    mimeType: text("mime_type").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    sha256: sha256Column("sha256").notNull(),
    generator: text("generator").notNull(),
    generatorVersion: integer("generator_version").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("derived_assets_version_kind_path_unique").on(t.artifactVersionId, t.kind, t.path),
    check("derived_assets_kind_check", oneOf(t.kind, DERIVED_KINDS)),
  ],
);

// ---------- extraction ----------
export const extractedDocuments = pgTable(
  "extracted_documents",
  {
    id: idColumn(),
    workspaceId: workspaceRef(),
    artifactVersionId: uuid("artifact_version_id")
      .notNull()
      .references(() => artifactVersions.id, { onDelete: "cascade" }),
    extractionMethod: text("extraction_method").notNull(),
    extractionVersion: integer("extraction_version").notNull(),
    status: text("status").$type<ExtractionStatus>().notNull(),
    title: text("title"),
    language: text("language"),
    plainText: text("plain_text").notNull().default(""),
    normalizedMarkdown: text("normalized_markdown").notNull().default(""),
    contentHash: sha256Column("content_hash"),
    charCount: integer("char_count").notNull().default(0),
    warnings: jsonb("warnings").$type<string[]>().notNull().default([]),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    extractedAt: timestamp("extracted_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    check("extracted_documents_status_check", oneOf(t.status, EXTRACTION_STATUSES)),
    index("extracted_documents_version_idx").on(t.artifactVersionId, t.createdAt.desc()),
  ],
);

export const documentSections = pgTable(
  "document_sections",
  {
    id: idColumn(),
    extractedDocumentId: uuid("extracted_document_id")
      .notNull()
      .references(() => extractedDocuments.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    level: integer("level").notNull(),
    heading: text("heading"),
    anchor: text("anchor").notNull(),
    charStart: integer("char_start").notNull(),
    charEnd: integer("char_end").notNull(),
  },
  (t) => [
    unique("document_sections_document_ordinal_unique").on(t.extractedDocumentId, t.ordinal),
    check("document_sections_level_check", sql`${t.level} between 0 and 6`),
    check(
      "document_sections_range_check",
      sql`${t.charStart} >= 0 and ${t.charEnd} >= ${t.charStart}`,
    ),
  ],
);

// ---------- imports ----------
export interface ImportBatchOptions {
  autoVersionByFilename?: boolean;
  sourcePlatform?: string;
}

export const importBatches = pgTable(
  "import_batches",
  {
    id: idColumn(),
    workspaceId: workspaceRef(),
    createdBy: createdBy(),
    status: text("status").$type<BatchStatus>().notNull().default("open"),
    targetProjectId: uuid("target_project_id").references(() => researchProjects.id, {
      onDelete: "set null",
    }),
    targetCollectionId: uuid("target_collection_id").references(() => collections.id, {
      onDelete: "set null",
    }),
    options: jsonb("options").$type<ImportBatchOptions>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    check("import_batches_status_check", oneOf(t.status, BATCH_STATUSES)),
    index("import_batches_workspace_created_idx").on(t.workspaceId, t.createdAt.desc()),
  ],
);

export const importItems = pgTable(
  "import_items",
  {
    id: idColumn(),
    workspaceId: workspaceRef(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => importBatches.id, { onDelete: "cascade" }),
    clientKey: text("client_key"),
    originalFilename: text("original_filename").notNull(),
    declaredSize: bigint("declared_size", { mode: "number" }).notNull(),
    declaredMime: text("declared_mime"),
    stagingKey: text("staging_key").notNull(),
    status: text("status").$type<ItemStatus>().notNull().default("awaiting_upload"),
    outcome: text("outcome").$type<ItemOutcome>(),
    targetArtifactId: uuid("target_artifact_id").references(() => artifacts.id, {
      onDelete: "set null",
    }),
    fileAssetId: uuid("file_asset_id").references(() => fileAssets.id, { onDelete: "set null" }),
    resultArtifactId: uuid("result_artifact_id").references(() => artifacts.id, {
      onDelete: "set null",
    }),
    resultVersionId: uuid("result_version_id").references(() => artifactVersions.id, {
      onDelete: "set null",
    }),
    suspectedDuplicateOf: uuid("suspected_duplicate_of").references(() => artifacts.id, {
      onDelete: "set null",
    }),
    matchReason: text("match_reason").$type<MatchReason>(),
    detectedType: text("detected_type"),
    sha256: sha256Column("sha256"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    warnings: jsonb("warnings").$type<string[]>().notNull().default([]),
    uploadExpiresAt: timestamp("upload_expires_at", { withTimezone: true }).notNull(),
    /** When the staged upload object was deleted (cleanup bookkeeping; NULL = may still exist). */
    stagingCleanedAt: timestamp("staging_cleaned_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    unique("import_items_batch_client_key_unique").on(t.batchId, t.clientKey),
    check("import_items_status_check", oneOf(t.status, ITEM_STATUSES)),
    check(
      "import_items_outcome_check",
      sql`${t.outcome} is null or ${oneOf(t.outcome, ITEM_OUTCOMES)}`,
    ),
    check(
      "import_items_match_reason_check",
      sql`${t.matchReason} is null or ${oneOf(t.matchReason, MATCH_REASONS)}`,
    ),
    check("import_items_declared_size_check", sql`${t.declaredSize} >= 0`),
    index("import_items_batch_status_idx").on(t.batchId, t.status),
    index("import_items_status_expiry_idx").on(t.status, t.uploadExpiresAt),
    index("import_items_staging_cleanup_idx")
      .on(t.status, t.completedAt)
      .where(sql`${t.stagingCleanedAt} is null`),
  ],
);
