ALTER TABLE "canonical_thread_projections" DROP CONSTRAINT IF EXISTS "canonical_thread_projections_title_source_check";
--> statement-breakpoint
ALTER TABLE "canonical_thread_projections" ADD CONSTRAINT "canonical_thread_projections_title_source_check" CHECK (title_source IN ('user', 'preview', 'generated', 'imported', 'none'));
