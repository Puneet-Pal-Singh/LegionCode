CREATE TABLE "artifact_changed_files" (
	"artifact_id" uuid NOT NULL,
	"path" text NOT NULL,
	"change_type" text NOT NULL,
	"additions" integer,
	"deletions" integer,
	"metadata_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "artifact_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"artifact_id" uuid NOT NULL,
	"run_id" text NOT NULL,
	"event_type" text NOT NULL,
	"message" text NOT NULL,
	"metadata_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_events_type_check" CHECK (event_type IN ('capture_started', 'r2_write_succeeded', 'metadata_commit_succeeded', 'capture_failed', 'restore_attempted', 'restored', 'restore_failed', 'requires_user_resolution', 'anchored', 'discarded', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"run_id" text NOT NULL,
	"repo_owner" text,
	"repo_name" text,
	"repo_url" text,
	"branch" text,
	"base_commit_sha" text,
	"head_commit_sha" text,
	"artifact_kind" text NOT NULL,
	"r2_object_key" text NOT NULL,
	"content_type" text,
	"size_bytes" integer,
	"sha256" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "artifacts_kind_check" CHECK (artifact_kind IN ('git_patch', 'file_snapshot')),
	CONSTRAINT "artifacts_status_check" CHECK (status IN ('pending', 'stored', 'capture_failed', 'restore_in_progress', 'restored', 'anchored', 'discarded', 'expired', 'restore_failed', 'requires_user_resolution'))
);
--> statement-breakpoint
ALTER TABLE "artifact_changed_files" ADD CONSTRAINT "artifact_changed_files_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_events" ADD CONSTRAINT "artifact_events_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_events" ADD CONSTRAINT "artifact_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_changed_files_artifact_path_idx" ON "artifact_changed_files" USING btree ("artifact_id","path");--> statement-breakpoint
CREATE INDEX "artifact_events_artifact_created_idx" ON "artifact_events" USING btree ("artifact_id","created_at");--> statement-breakpoint
CREATE INDEX "artifact_events_run_created_idx" ON "artifact_events" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_r2_object_key_idx" ON "artifacts" USING btree ("r2_object_key");--> statement-breakpoint
CREATE INDEX "artifacts_user_workspace_updated_idx" ON "artifacts" USING btree ("user_id","workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "artifacts_run_status_updated_idx" ON "artifacts" USING btree ("run_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "artifacts_expiry_status_idx" ON "artifacts" USING btree ("expires_at","status");
