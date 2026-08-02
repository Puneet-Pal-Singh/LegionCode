import type { SqlMigration } from "./types.js";

/**
 * Persists only the opaque Secure API session reference required to rotate a
 * bearer after a Brain restart. The bearer itself remains owned by Secure API
 * and never enters PostgreSQL, lifecycle events, logs, or client projections.
 *
 * Setting NOT NULL deliberately fails a partially deployed database that has
 * checkout rows without resumable provenance. Such rows cannot be recovered
 * safely and must not be guessed or silently replaced.
 */
export const taskCheckoutSecureSessionMigration: SqlMigration = {
  id: "0028_task_checkout_secure_session",
  description:
    "Bind task checkouts to an opaque resumable Secure API session reference",
  statements: [
    `ALTER TABLE task_checkouts ADD COLUMN IF NOT EXISTS secure_session_id TEXT`,
    `ALTER TABLE task_checkouts ALTER COLUMN secure_session_id SET NOT NULL`,
    `ALTER TABLE task_checkouts ADD CONSTRAINT task_checkouts_secure_session_unique UNIQUE (secure_session_id)`,
    `ALTER TABLE task_checkouts DROP CONSTRAINT IF EXISTS task_checkouts_generation_check`,
    `ALTER TABLE task_checkouts ADD CONSTRAINT task_checkouts_generation_check CHECK (generation >= 0)`,
    `
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
           NEW.secure_session_id IS DISTINCT FROM OLD.secure_session_id OR
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

        IF OLD.status = 'ready' AND NEW.status = 'active' AND
           NEW.settled_at IS NULL AND NEW.failure_code IS NULL THEN
          RETURN NEW;
        END IF;
        IF OLD.status = 'active' AND NEW.status = 'settled' AND
           NEW.settled_at IS NOT NULL AND NEW.failure_code IS NULL THEN
          RETURN NEW;
        END IF;
        IF OLD.status = 'active' AND NEW.status = 'failed' AND
           NEW.settled_at IS NOT NULL AND NEW.failure_code IS NOT NULL THEN
          RETURN NEW;
        END IF;

        RAISE EXCEPTION 'task checkout transition is invalid';
      END;
      $$ LANGUAGE plpgsql
    `,
  ],
};
