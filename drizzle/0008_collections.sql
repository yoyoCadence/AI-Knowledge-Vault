CREATE TABLE "collection_items" (
	"workspace_id" uuid NOT NULL,
	"collection_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_items_collection_id_artifact_id_pk" PRIMARY KEY("collection_id","artifact_id")
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"parent_id" uuid,
	"kind" text DEFAULT 'collection' NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collections_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "collections_sibling_name_unique" UNIQUE NULLS NOT DISTINCT("workspace_id","parent_id","normalized_name"),
	CONSTRAINT "collections_kind_check" CHECK ("kind" in ('category', 'collection')),
	CONSTRAINT "collections_name_length_check" CHECK (char_length("collections"."name") between 1 and 100),
	CONSTRAINT "collections_not_own_parent_check" CHECK ("collections"."parent_id" is distinct from "collections"."id")
);
--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_collection_fk" FOREIGN KEY ("workspace_id","collection_id") REFERENCES "public"."collections"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_artifact_fk" FOREIGN KEY ("workspace_id","artifact_id") REFERENCES "public"."artifacts"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_parent_fk" FOREIGN KEY ("workspace_id","parent_id") REFERENCES "public"."collections"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collection_items_artifact_idx" ON "collection_items" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "collections_parent_idx" ON "collections" USING btree ("parent_id");--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_target_collection_id_collections_id_fk" FOREIGN KEY ("target_collection_id") REFERENCES "public"."collections"("id") ON DELETE set null ON UPDATE no action;