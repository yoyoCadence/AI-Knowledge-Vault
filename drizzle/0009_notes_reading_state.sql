CREATE TABLE "artifact_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"author_id" uuid,
	"body_markdown" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_notes_body_length_check" CHECK (char_length("artifact_notes"."body_markdown") between 1 and 20000)
);
--> statement-breakpoint
CREATE TABLE "artifact_reading_states" (
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"status" text DEFAULT 'unread' NOT NULL,
	"is_favorite" boolean DEFAULT false NOT NULL,
	"last_opened_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_reading_states_user_id_artifact_id_pk" PRIMARY KEY("user_id","artifact_id"),
	CONSTRAINT "artifact_reading_states_status_check" CHECK ("status" in ('unread', 'reading', 'read'))
);
--> statement-breakpoint
ALTER TABLE "artifact_notes" ADD CONSTRAINT "artifact_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_notes" ADD CONSTRAINT "artifact_notes_artifact_fk" FOREIGN KEY ("workspace_id","artifact_id") REFERENCES "public"."artifacts"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_reading_states" ADD CONSTRAINT "artifact_reading_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_reading_states" ADD CONSTRAINT "artifact_reading_states_artifact_fk" FOREIGN KEY ("workspace_id","artifact_id") REFERENCES "public"."artifacts"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_notes_artifact_idx" ON "artifact_notes" USING btree ("artifact_id","created_at");--> statement-breakpoint
CREATE INDEX "artifact_reading_states_recent_idx" ON "artifact_reading_states" USING btree ("user_id","last_opened_at","artifact_id");--> statement-breakpoint
CREATE INDEX "artifact_reading_states_artifact_idx" ON "artifact_reading_states" USING btree ("artifact_id");