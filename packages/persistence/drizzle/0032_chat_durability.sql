ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "thread_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_thread_id_idx" ON "sessions" ("thread_id") WHERE "thread_id" IS NOT NULL;
--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM sessions WHERE thread_id IS NOT NULL GROUP BY thread_id HAVING COUNT(*) > 1) THEN RAISE EXCEPTION 'duplicate session thread_id values prevent immutable thread ownership'; END IF; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sessions_thread_id_unique_idx" ON "sessions" ("thread_id") WHERE "thread_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "canonical_turn_id" text;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "canonical_run_attempt_id" text;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "canonical_item_id" text;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "canonical_phase" text;
--> statement-breakpoint
ALTER TABLE "message_parts" ADD COLUMN IF NOT EXISTS "source_event_id" text;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "thread_binding_source" text;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "thread_binding_migration_id" text;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "thread_id_migrated_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "current_turn_id" text;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "admission_sequence" bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_thread_binding_source_check') THEN ALTER TABLE sessions ADD CONSTRAINT sessions_thread_binding_source_check CHECK (thread_binding_source IS NULL OR thread_binding_source IN ('existing','runtime_admission','legacy_recovery')); END IF; END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_thread_id_rebinding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.thread_id IS NOT NULL AND NEW.thread_id IS DISTINCT FROM OLD.thread_id THEN RAISE EXCEPTION 'session thread_id is immutable'; END IF; RETURN NEW; END $$;
--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'sessions_thread_id_immutable') THEN CREATE TRIGGER sessions_thread_id_immutable BEFORE UPDATE OF thread_id ON sessions FOR EACH ROW EXECUTE FUNCTION prevent_thread_id_rebinding(); END IF; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "messages_canonical_item_phase_idx" ON "messages" ("session_id", "canonical_turn_id", "canonical_run_attempt_id", "canonical_item_id", "canonical_phase") WHERE "canonical_turn_id" IS NOT NULL AND "canonical_run_attempt_id" IS NOT NULL AND "canonical_item_id" IS NOT NULL AND "canonical_phase" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "message_parts_source_event_id_idx" ON "message_parts" ("source_event_id") WHERE "source_event_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "canonical_turn_admissions" (
  "session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  "client_message_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "turn_id" text NOT NULL UNIQUE,
  "run_attempt_id" text NOT NULL UNIQUE,
  "run_id" text NOT NULL,
  "workspace_id" text,
  "revision_of_turn_id" text,
  "admission_order" bigint,
  "admission_state" text NOT NULL CHECK ("admission_state" IN ('reserved','admitted')),
  "execution_state" text NOT NULL DEFAULT 'pending' CHECK ("execution_state" IN ('pending','running','recovery_required','settled')),
  "execution_claim_id" text,
  "execution_claimed_at" timestamptz,
  "request_fingerprint" text,
  "provenance" text NOT NULL DEFAULT 'runtime',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "admitted_at" timestamptz,
  PRIMARY KEY ("session_id", "client_message_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "canonical_turn_admissions_session_turn_idx" ON "canonical_turn_admissions" ("session_id", "turn_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "canonical_turn_admissions_session_order_idx" ON "canonical_turn_admissions" ("session_id", "admission_order") WHERE "admission_order" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "canonical_turn_admissions_run_idx" ON "canonical_turn_admissions" ("run_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conversation_recovery_checkpoints" (
  "migration_id" text NOT NULL,
  "session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  "source_fingerprint" text NOT NULL,
  "target_fingerprint" text,
  "status" text NOT NULL CHECK ("status" IN ('started','completed','conflict')),
  "message_count" integer NOT NULL DEFAULT 0,
  "part_count" integer NOT NULL DEFAULT 0,
  "details_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "migrated_at" timestamptz,
  PRIMARY KEY ("migration_id", "session_id")
);
