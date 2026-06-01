ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "user_message_id" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "assistant_message_id" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "source_turn_id" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "capture_sequence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "patch_parse_status" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "patch_sha256" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "storage_backend" text DEFAULT 'r2_postgres' NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "cf_artifact_repo" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "cf_artifact_commit_sha" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "cf_artifact_path" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "storage_reconciliation_status" text;--> statement-breakpoint
ALTER TABLE "artifacts" DROP CONSTRAINT IF EXISTS "artifacts_status_check";--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_status_check" CHECK (status IN ('pending', 'stored', 'stored_with_secondary', 'secondary_write_failed', 'capture_failed', 'restore_in_progress', 'restored', 'anchored', 'discarded', 'expired', 'restore_failed', 'requires_user_resolution'));--> statement-breakpoint
ALTER TABLE "artifact_events" DROP CONSTRAINT IF EXISTS "artifact_events_type_check";--> statement-breakpoint
ALTER TABLE "artifact_events" ADD CONSTRAINT "artifact_events_type_check" CHECK (event_type IN ('capture_started', 'r2_write_succeeded', 'patch_parse_succeeded', 'patch_parse_failed', 'cf_artifacts_write_succeeded', 'cf_artifacts_write_failed', 'reconciliation_succeeded', 'reconciliation_failed', 'metadata_commit_succeeded', 'capture_failed', 'restore_attempted', 'restored', 'restore_failed', 'requires_user_resolution', 'anchored', 'discarded', 'expired'));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifacts_run_assistant_message_idx" ON "artifacts" USING btree ("run_id","assistant_message_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifacts_run_session_created_idx" ON "artifacts" USING btree ("run_id","session_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifacts_storage_reconciliation_idx" ON "artifacts" USING btree ("storage_reconciliation_status","created_at");
