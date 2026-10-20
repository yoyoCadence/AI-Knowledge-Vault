CREATE TABLE "export_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"requested_by" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"format_version" integer NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"storage_key" text,
	"filename" text,
	"byte_size" bigint,
	"sha256" char(64),
	"manifest_summary" jsonb,
	"error_message" text,
	"job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	CONSTRAINT "export_runs_status_check" CHECK ("status" in ('queued', 'running', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "integrity_checks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"checked_count" integer DEFAULT 0 NOT NULL,
	"ok_count" integer DEFAULT 0 NOT NULL,
	"missing_count" integer DEFAULT 0 NOT NULL,
	"corrupt_count" integer DEFAULT 0 NOT NULL,
	"report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "integrity_checks_status_check" CHECK ("status" in ('queued', 'running', 'completed', 'failed')),
	CONSTRAINT "integrity_checks_counts_check" CHECK ("integrity_checks"."checked_count" >= 0 and "integrity_checks"."ok_count" >= 0 and "integrity_checks"."missing_count" >= 0 and "integrity_checks"."corrupt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "restore_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"requested_by" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"source_storage_key" text,
	"source_sha256" char(64),
	"mode" text DEFAULT 'skip_existing' NOT NULL,
	"report" jsonb,
	"error_code" text,
	"error_message" text,
	"job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "restore_runs_status_check" CHECK ("status" in ('queued', 'running', 'completed', 'failed')),
	CONSTRAINT "restore_runs_mode_check" CHECK ("mode" in ('skip_existing', 'copy'))
);
--> statement-breakpoint
ALTER TABLE "export_runs" ADD CONSTRAINT "export_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_runs" ADD CONSTRAINT "export_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_runs" ADD CONSTRAINT "export_runs_job_id_processing_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."processing_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrity_checks" ADD CONSTRAINT "integrity_checks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_runs" ADD CONSTRAINT "restore_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_runs" ADD CONSTRAINT "restore_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_runs" ADD CONSTRAINT "restore_runs_job_id_processing_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."processing_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "export_runs_workspace_created_idx" ON "export_runs" USING btree ("workspace_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "integrity_checks_workspace_started_idx" ON "integrity_checks" USING btree ("workspace_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "restore_runs_workspace_created_idx" ON "restore_runs" USING btree ("workspace_id","created_at" DESC NULLS LAST);