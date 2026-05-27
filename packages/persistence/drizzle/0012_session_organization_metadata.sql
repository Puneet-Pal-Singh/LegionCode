ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "title_source" TEXT NOT NULL DEFAULT 'generated';--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "pinned_at" TIMESTAMPTZ;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "archived_at" TIMESTAMPTZ;--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_title_source_check";--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_title_source_check" CHECK (title_source IN ('generated', 'user'));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_user_archived_updated_idx" ON "sessions" USING btree ("user_id","archived_at","updated_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_user_pinned_idx" ON "sessions" USING btree ("user_id","pinned_at" DESC) WHERE pinned_at IS NOT NULL AND archived_at IS NULL;
