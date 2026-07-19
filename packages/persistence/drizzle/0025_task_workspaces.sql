CREATE TABLE IF NOT EXISTS "workspace_snapshots" (
  "snapshot_id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL,
  "repository_provider" text NOT NULL,
  "repository_owner" text,
  "repository_name" text NOT NULL,
  "repository_url" text NOT NULL,
  "authorized_commit_id" text NOT NULL,
  "authorized_tree_id" text NOT NULL,
  "manifest_digest" text NOT NULL,
  "config_digest" text NOT NULL,
  "captured_at" timestamp with time zone NOT NULL,
  "provenance_json" jsonb NOT NULL,
  CONSTRAINT "workspace_snapshots_identity_scope_unique" UNIQUE("snapshot_id", "workspace_id"),
  CONSTRAINT "workspace_snapshots_manifest_digest_check" CHECK ("manifest_digest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "workspace_snapshots_config_digest_check" CHECK ("config_digest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "workspace_snapshots_commit_check" CHECK ("authorized_commit_id" ~ '^[a-f0-9]{40,64}$'),
  CONSTRAINT "workspace_snapshots_tree_check" CHECK ("authorized_tree_id" ~ '^[a-f0-9]{40,64}$')
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_workspace_snapshot_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'workspace snapshots are immutable';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER workspace_snapshots_immutable_trigger BEFORE UPDATE OR DELETE ON "workspace_snapshots" FOR EACH ROW EXECUTE FUNCTION reject_workspace_snapshot_mutation();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_checkouts" (
  "checkout_id" text PRIMARY KEY NOT NULL,
  "snapshot_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "turn_id" text NOT NULL,
  "run_attempt_id" text NOT NULL,
  "lease_id" text NOT NULL,
  "sandbox_id" text NOT NULL,
  "filesystem_root" text NOT NULL,
  "git_dir" text NOT NULL,
  "index_file" text NOT NULL,
  "working_branch" text NOT NULL,
  "start_tree_id" text NOT NULL,
  "generation" integer NOT NULL,
  "status" text NOT NULL,
  "settled_at" timestamp with time zone,
  "failure_code" text,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "task_checkouts_snapshot_workspace_fk" FOREIGN KEY ("snapshot_id", "workspace_id") REFERENCES "workspace_snapshots"("snapshot_id", "workspace_id") ON DELETE RESTRICT,
  CONSTRAINT "task_checkouts_run_attempt_unique" UNIQUE("run_attempt_id"),
  CONSTRAINT "task_checkouts_lease_unique" UNIQUE("lease_id"),
  CONSTRAINT "task_checkouts_generation_check" CHECK ("generation" >= 0),
  CONSTRAINT "task_checkouts_status_check" CHECK ("status" IN ('ready', 'active', 'settled', 'failed')),
  CONSTRAINT "task_checkouts_start_tree_check" CHECK ("start_tree_id" ~ '^[a-f0-9]{40,64}$'),
  CONSTRAINT "task_checkouts_paths_distinct_check" CHECK ("filesystem_root" <> "git_dir" AND "filesystem_root" <> "index_file" AND "git_dir" <> "index_file"),
  CONSTRAINT "task_checkouts_paths_absolute_check" CHECK ("filesystem_root" ~ '^/' AND "git_dir" ~ '^/' AND "index_file" ~ '^/' AND "filesystem_root" !~ '(^|/)\\.\\.?($|/)' AND "git_dir" !~ '(^|/)\\.\\.?($|/)' AND "index_file" !~ '(^|/)\\.\\.?($|/)'),
  CONSTRAINT "task_checkouts_terminal_fields_check" CHECK (("status" IN ('ready', 'active') AND "settled_at" IS NULL AND "failure_code" IS NULL) OR ("status" = 'settled' AND "settled_at" IS NOT NULL AND "failure_code" IS NULL) OR ("status" = 'failed' AND "settled_at" IS NOT NULL AND "failure_code" IS NOT NULL))
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_task_checkout_transition()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'ready' AND NEW.settled_at IS NULL AND NEW.failure_code IS NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'task checkouts must be created ready';
  END IF;
  IF NEW.checkout_id IS DISTINCT FROM OLD.checkout_id OR
     NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id OR
     NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR
     NEW.thread_id IS DISTINCT FROM OLD.thread_id OR
     NEW.turn_id IS DISTINCT FROM OLD.turn_id OR
     NEW.run_attempt_id IS DISTINCT FROM OLD.run_attempt_id OR
     NEW.filesystem_root IS DISTINCT FROM OLD.filesystem_root OR
     NEW.git_dir IS DISTINCT FROM OLD.git_dir OR
     NEW.index_file IS DISTINCT FROM OLD.index_file OR
     NEW.working_branch IS DISTINCT FROM OLD.working_branch OR
     NEW.start_tree_id IS DISTINCT FROM OLD.start_tree_id OR
     NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'task checkout binding is immutable';
  END IF;
  IF OLD.status IN ('ready', 'active') AND NEW.status = OLD.status AND
     NEW.settled_at IS NULL AND NEW.failure_code IS NULL AND
     NEW.generation = OLD.generation + 1 AND
     NEW.lease_id IS DISTINCT FROM OLD.lease_id AND
     NEW.sandbox_id IS DISTINCT FROM OLD.sandbox_id THEN
    RETURN NEW;
  END IF;
  IF NEW.lease_id IS DISTINCT FROM OLD.lease_id OR
     NEW.sandbox_id IS DISTINCT FROM OLD.sandbox_id OR
     NEW.generation IS DISTINCT FROM OLD.generation THEN
    RAISE EXCEPTION 'task checkout lease replacement is invalid';
  END IF;
  IF OLD.status = 'ready' AND NEW.status = 'active' AND NEW.settled_at IS NULL AND NEW.failure_code IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'active' AND NEW.status = 'settled' AND NEW.settled_at IS NOT NULL AND NEW.failure_code IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'active' AND NEW.status = 'failed' AND NEW.settled_at IS NOT NULL AND NEW.failure_code IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'task checkout transition is invalid';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER task_checkouts_transition_trigger BEFORE INSERT OR UPDATE ON "task_checkouts" FOR EACH ROW EXECUTE FUNCTION enforce_task_checkout_transition();
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_checkouts_workspace_thread_idx" ON "task_checkouts" ("workspace_id", "thread_id", "created_at" DESC);
