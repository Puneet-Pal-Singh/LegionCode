ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "thread_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_thread_id_idx"
  ON "sessions" ("thread_id")
  WHERE "thread_id" IS NOT NULL;
