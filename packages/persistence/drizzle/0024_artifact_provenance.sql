ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "thread_id" text;
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "turn_id" text;
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "run_attempt_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifacts_provenance_lookup_idx" ON "artifacts" ("run_id", "workspace_id", "thread_id", "turn_id", "run_attempt_id", "assistant_message_id", "created_at" DESC);
