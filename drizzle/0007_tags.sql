ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_workspace_id_id_unique" UNIQUE("workspace_id","id");--> statement-breakpoint
CREATE TABLE "artifact_tags" (
	"workspace_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_tags_artifact_id_tag_id_pk" PRIMARY KEY("artifact_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_workspace_normalized_name_unique" UNIQUE("workspace_id","normalized_name"),
	CONSTRAINT "tags_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "tags_name_length_check" CHECK (char_length("tags"."name") between 1 and 50)
);
--> statement-breakpoint
ALTER TABLE "artifact_tags" ADD CONSTRAINT "artifact_tags_artifact_fk" FOREIGN KEY ("workspace_id","artifact_id") REFERENCES "public"."artifacts"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_tags" ADD CONSTRAINT "artifact_tags_tag_fk" FOREIGN KEY ("workspace_id","tag_id") REFERENCES "public"."tags"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_tags_tag_idx" ON "artifact_tags" USING btree ("tag_id");