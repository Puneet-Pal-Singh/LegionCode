CREATE TABLE "context_snapshot_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"context_snapshot_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"source_range_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"run_id" text,
	"snapshot_kind" text NOT NULL,
	"r2_object_key" text,
	"payload_size_bytes" integer,
	"token_count" integer,
	"trigger_reason" text,
	"source_message_range_json" jsonb,
	"summary_message_id" uuid,
	"replacement_history_r2_object_key" text,
	"usage_before_json" jsonb,
	"usage_after_json" jsonb,
	"validation_json" jsonb,
	"model_info_json" jsonb,
	"media_artifacts_json" jsonb,
	"continuity_state_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"run_id" text,
	"event_type" text NOT NULL,
	"payload_json" jsonb,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permission_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"permission_request_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"payload_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permission_decisions_kind_check" CHECK (decision IN ('allow_once', 'allow_for_run', 'allow_persistent_rule', 'deny', 'abort'))
);
--> statement-breakpoint
CREATE TABLE "permission_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"run_id" text NOT NULL,
	"request_type" text NOT NULL,
	"status" text NOT NULL,
	"payload_json" jsonb,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "permission_requests_status_check" CHECK (status IN ('pending', 'resolved', 'expired', 'aborted'))
);
--> statement-breakpoint
ALTER TABLE "context_snapshot_sources" ADD CONSTRAINT "context_snapshot_sources_context_snapshot_id_context_snapshots_id_fk" FOREIGN KEY ("context_snapshot_id") REFERENCES "public"."context_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_snapshots" ADD CONSTRAINT "context_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_snapshots" ADD CONSTRAINT "context_snapshots_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_snapshots" ADD CONSTRAINT "context_snapshots_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_snapshots" ADD CONSTRAINT "context_snapshots_summary_message_id_messages_id_fk" FOREIGN KEY ("summary_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_events" ADD CONSTRAINT "memory_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_events" ADD CONSTRAINT "memory_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_events" ADD CONSTRAINT "memory_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_decisions" ADD CONSTRAINT "permission_decisions_permission_request_id_permission_requests_id_fk" FOREIGN KEY ("permission_request_id") REFERENCES "public"."permission_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_decisions" ADD CONSTRAINT "permission_decisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_requests" ADD CONSTRAINT "permission_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_requests" ADD CONSTRAINT "permission_requests_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_requests" ADD CONSTRAINT "permission_requests_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "snapshot_sources_snapshot_idx" ON "context_snapshot_sources" USING btree ("context_snapshot_id");--> statement-breakpoint
CREATE INDEX "snapshot_sources_type_id_idx" ON "context_snapshot_sources" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "context_snapshots_session_idx" ON "context_snapshots" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "context_snapshots_run_idx" ON "context_snapshots" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "memory_events_session_created_idx" ON "memory_events" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_events_session_idempotency_idx" ON "memory_events" USING btree ("session_id","idempotency_key") WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "permission_decisions_request_created_idx" ON "permission_decisions" USING btree ("permission_request_id","created_at");--> statement-breakpoint
CREATE INDEX "permission_decisions_user_created_idx" ON "permission_decisions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "permission_requests_run_created_idx" ON "permission_requests" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "permission_requests_user_status_created_idx" ON "permission_requests" USING btree ("user_id","status","created_at");
