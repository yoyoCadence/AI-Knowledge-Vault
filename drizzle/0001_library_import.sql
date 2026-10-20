CREATE TABLE "artifact_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"artifact_version_id" uuid NOT NULL,
	"file_asset_id" uuid NOT NULL,
	"role" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_files_version_asset_role_unique" UNIQUE("artifact_version_id","file_asset_id","role"),
	CONSTRAINT "artifact_files_role_check" CHECK ("role" in ('original', 'attachment', 'cover'))
);
--> statement-breakpoint
CREATE TABLE "artifact_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"primary_file_id" uuid NOT NULL,
	"content_kind" text NOT NULL,
	"preview_kind" text NOT NULL,
	"preview_status" text DEFAULT 'pending' NOT NULL,
	"preview_entry_path" text,
	"processing_status" text DEFAULT 'pending' NOT NULL,
	"active_extraction_id" uuid,
	"content_hash" char(64),
	"source_platform" text,
	"source_model" text,
	"original_prompt" text,
	"source_url" text,
	"research_date" date,
	"author" text,
	"reference_sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"change_summary" text,
	"analysis" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"import_item_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_versions_artifact_number_unique" UNIQUE("artifact_id","version_number"),
	CONSTRAINT "artifact_versions_number_check" CHECK ("artifact_versions"."version_number" >= 1),
	CONSTRAINT "artifact_versions_content_kind_check" CHECK ("content_kind" in ('html_document', 'claude_design_document', 'static_site', 'framework_project', 'pdf', 'markdown', 'text', 'image', 'archive_other', 'unknown')),
	CONSTRAINT "artifact_versions_preview_kind_check" CHECK ("preview_kind" in ('static_html', 'static_site', 'framework_source', 'unsupported', 'pdf', 'image', 'text_only')),
	CONSTRAINT "artifact_versions_preview_status_check" CHECK ("preview_status" in ('pending', 'ready', 'unavailable', 'failed')),
	CONSTRAINT "artifact_versions_processing_status_check" CHECK ("processing_status" in ('pending', 'processing', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"summary" text,
	"visibility" text DEFAULT 'private' NOT NULL,
	"sensitivity" text DEFAULT 'normal' NOT NULL,
	"review_status" text DEFAULT 'unreviewed' NOT NULL,
	"identity_key" text,
	"current_version_id" uuid,
	"origin_ref" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "artifacts_visibility_check" CHECK ("visibility" in ('private', 'unlisted', 'public')),
	CONSTRAINT "artifacts_sensitivity_check" CHECK ("sensitivity" in ('normal', 'sensitive', 'restricted')),
	CONSTRAINT "artifacts_review_status_check" CHECK ("review_status" in ('unreviewed', 'reviewed', 'verified', 'disputed'))
);
--> statement-breakpoint
CREATE TABLE "derived_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"artifact_version_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"path" text DEFAULT '' NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"sha256" char(64) NOT NULL,
	"generator" text NOT NULL,
	"generator_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "derived_assets_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "derived_assets_version_kind_path_unique" UNIQUE("artifact_version_id","kind","path"),
	CONSTRAINT "derived_assets_kind_check" CHECK ("kind" in ('preview_file', 'thumbnail'))
);
--> statement-breakpoint
CREATE TABLE "document_sections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"extracted_document_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"level" integer NOT NULL,
	"heading" text,
	"anchor" text NOT NULL,
	"char_start" integer NOT NULL,
	"char_end" integer NOT NULL,
	CONSTRAINT "document_sections_document_ordinal_unique" UNIQUE("extracted_document_id","ordinal"),
	CONSTRAINT "document_sections_level_check" CHECK ("document_sections"."level" between 0 and 6),
	CONSTRAINT "document_sections_range_check" CHECK ("document_sections"."char_start" >= 0 and "document_sections"."char_end" >= "document_sections"."char_start")
);
--> statement-breakpoint
CREATE TABLE "extracted_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"artifact_version_id" uuid NOT NULL,
	"extraction_method" text NOT NULL,
	"extraction_version" integer NOT NULL,
	"status" text NOT NULL,
	"title" text,
	"language" text,
	"plain_text" text DEFAULT '' NOT NULL,
	"normalized_markdown" text DEFAULT '' NOT NULL,
	"content_hash" char(64),
	"char_count" integer DEFAULT 0 NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_code" text,
	"error_message" text,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extracted_documents_status_check" CHECK ("status" in ('succeeded', 'partial', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "file_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"storage_provider" text NOT NULL,
	"storage_key" text NOT NULL,
	"original_filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"sha256" char(64) NOT NULL,
	"storage_status" text DEFAULT 'stored' NOT NULL,
	"integrity_verified_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_assets_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "file_assets_workspace_sha256_unique" UNIQUE("workspace_id","sha256"),
	CONSTRAINT "file_assets_storage_provider_check" CHECK ("storage_provider" in ('local', 's3')),
	CONSTRAINT "file_assets_storage_status_check" CHECK ("storage_status" in ('stored', 'missing', 'corrupt')),
	CONSTRAINT "file_assets_byte_size_check" CHECK ("file_assets"."byte_size" >= 0),
	CONSTRAINT "file_assets_sha256_format_check" CHECK ("file_assets"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"target_project_id" uuid,
	"target_collection_id" uuid,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "import_batches_status_check" CHECK ("status" in ('open', 'processing', 'completed', 'completed_with_errors', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "import_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"client_key" text,
	"original_filename" text NOT NULL,
	"declared_size" bigint NOT NULL,
	"declared_mime" text,
	"staging_key" text NOT NULL,
	"status" text DEFAULT 'awaiting_upload' NOT NULL,
	"outcome" text,
	"target_artifact_id" uuid,
	"file_asset_id" uuid,
	"result_artifact_id" uuid,
	"result_version_id" uuid,
	"suspected_duplicate_of" uuid,
	"match_reason" text,
	"detected_type" text,
	"sha256" char(64),
	"error_code" text,
	"error_message" text,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"upload_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "import_items_batch_client_key_unique" UNIQUE("batch_id","client_key"),
	CONSTRAINT "import_items_status_check" CHECK ("status" in ('awaiting_upload', 'uploaded', 'queued', 'processing', 'succeeded', 'duplicate', 'failed', 'cancelled', 'expired')),
	CONSTRAINT "import_items_outcome_check" CHECK ("import_items"."outcome" is null or "outcome" in ('new_artifact', 'new_version', 'duplicate_file')),
	CONSTRAINT "import_items_match_reason_check" CHECK ("import_items"."match_reason" is null or "match_reason" in ('explicit_target', 'filename_stem', 'same_hash')),
	CONSTRAINT "import_items_declared_size_check" CHECK ("import_items"."declared_size" >= 0)
);
--> statement-breakpoint
CREATE TABLE "research_projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "research_projects_status_check" CHECK ("status" in ('active', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "artifact_files" ADD CONSTRAINT "artifact_files_artifact_version_id_artifact_versions_id_fk" FOREIGN KEY ("artifact_version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_files" ADD CONSTRAINT "artifact_files_file_asset_id_file_assets_id_fk" FOREIGN KEY ("file_asset_id") REFERENCES "public"."file_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_primary_file_id_file_assets_id_fk" FOREIGN KEY ("primary_file_id") REFERENCES "public"."file_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_active_extraction_id_extracted_documents_id_fk" FOREIGN KEY ("active_extraction_id") REFERENCES "public"."extracted_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_import_item_id_import_items_id_fk" FOREIGN KEY ("import_item_id") REFERENCES "public"."import_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_project_id_research_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."research_projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_current_version_id_artifact_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "derived_assets" ADD CONSTRAINT "derived_assets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "derived_assets" ADD CONSTRAINT "derived_assets_artifact_version_id_artifact_versions_id_fk" FOREIGN KEY ("artifact_version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_sections" ADD CONSTRAINT "document_sections_extracted_document_id_extracted_documents_id_fk" FOREIGN KEY ("extracted_document_id") REFERENCES "public"."extracted_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_documents" ADD CONSTRAINT "extracted_documents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_documents" ADD CONSTRAINT "extracted_documents_artifact_version_id_artifact_versions_id_fk" FOREIGN KEY ("artifact_version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_target_project_id_research_projects_id_fk" FOREIGN KEY ("target_project_id") REFERENCES "public"."research_projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_target_artifact_id_artifacts_id_fk" FOREIGN KEY ("target_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_file_asset_id_file_assets_id_fk" FOREIGN KEY ("file_asset_id") REFERENCES "public"."file_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_result_artifact_id_artifacts_id_fk" FOREIGN KEY ("result_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_result_version_id_artifact_versions_id_fk" FOREIGN KEY ("result_version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_suspected_duplicate_of_artifacts_id_fk" FOREIGN KEY ("suspected_duplicate_of") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_projects" ADD CONSTRAINT "research_projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_projects" ADD CONSTRAINT "research_projects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_files_file_asset_idx" ON "artifact_files" USING btree ("file_asset_id");--> statement-breakpoint
CREATE INDEX "artifact_versions_workspace_content_hash_idx" ON "artifact_versions" USING btree ("workspace_id","content_hash");--> statement-breakpoint
CREATE INDEX "artifact_versions_primary_file_idx" ON "artifact_versions" USING btree ("primary_file_id");--> statement-breakpoint
CREATE INDEX "artifacts_workspace_listing_idx" ON "artifacts" USING btree ("workspace_id","deleted_at","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "artifacts_workspace_identity_idx" ON "artifacts" USING btree ("workspace_id","identity_key");--> statement-breakpoint
CREATE INDEX "artifacts_workspace_project_idx" ON "artifacts" USING btree ("workspace_id","project_id");--> statement-breakpoint
CREATE INDEX "extracted_documents_version_idx" ON "extracted_documents" USING btree ("artifact_version_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "import_batches_workspace_created_idx" ON "import_batches" USING btree ("workspace_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "import_items_batch_status_idx" ON "import_items" USING btree ("batch_id","status");--> statement-breakpoint
CREATE INDEX "import_items_status_expiry_idx" ON "import_items" USING btree ("status","upload_expires_at");--> statement-breakpoint
CREATE INDEX "research_projects_workspace_title_idx" ON "research_projects" USING btree ("workspace_id","title");