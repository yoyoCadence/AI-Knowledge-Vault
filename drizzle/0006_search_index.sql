CREATE TABLE "artifact_search_documents" (
	"artifact_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"search_vector" "tsvector" NOT NULL,
	"tokenizer_version" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_chunks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"artifact_version_id" uuid NOT NULL,
	"extracted_document_id" uuid NOT NULL,
	"section_id" uuid,
	"ordinal" integer NOT NULL,
	"text" text NOT NULL,
	"char_start" integer NOT NULL,
	"char_end" integer NOT NULL,
	"content_hash" char(64) NOT NULL,
	"tokenizer_version" integer NOT NULL,
	"search_vector" "tsvector" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_index_states" (
	"artifact_version_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"extracted_document_id" uuid,
	"tokenizer_version" integer NOT NULL,
	"chunk_count" integer NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artifact_search_documents" ADD CONSTRAINT "artifact_search_documents_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_search_documents" ADD CONSTRAINT "artifact_search_documents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_chunks" ADD CONSTRAINT "content_chunks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_chunks" ADD CONSTRAINT "content_chunks_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_chunks" ADD CONSTRAINT "content_chunks_artifact_version_id_artifact_versions_id_fk" FOREIGN KEY ("artifact_version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_chunks" ADD CONSTRAINT "content_chunks_extracted_document_id_extracted_documents_id_fk" FOREIGN KEY ("extracted_document_id") REFERENCES "public"."extracted_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_chunks" ADD CONSTRAINT "content_chunks_section_id_document_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."document_sections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_index_states" ADD CONSTRAINT "search_index_states_artifact_version_id_artifact_versions_id_fk" FOREIGN KEY ("artifact_version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_index_states" ADD CONSTRAINT "search_index_states_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_index_states" ADD CONSTRAINT "search_index_states_extracted_document_id_extracted_documents_id_fk" FOREIGN KEY ("extracted_document_id") REFERENCES "public"."extracted_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_search_documents_search_idx" ON "artifact_search_documents" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "artifact_search_documents_workspace_idx" ON "artifact_search_documents" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "content_chunks_search_idx" ON "content_chunks" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "content_chunks_workspace_artifact_idx" ON "content_chunks" USING btree ("workspace_id","artifact_id");--> statement-breakpoint
CREATE INDEX "content_chunks_version_idx" ON "content_chunks" USING btree ("artifact_version_id");