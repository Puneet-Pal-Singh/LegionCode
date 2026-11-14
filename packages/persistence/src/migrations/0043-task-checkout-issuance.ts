import type { SqlMigration } from "./types.js";

/** Reserve the existing checkout identity before any external freeze/acquire.
 * Incomplete issuance is deliberately not a public, physically ready checkout. */
export const taskCheckoutIssuanceMigration: SqlMigration = {
  id: "0043_task_checkout_issuance",
  description:
    "Fence one-shot execution domain issuance on existing task checkouts",
  statements: [
    `ALTER TABLE task_checkouts
      ADD COLUMN issuance_token TEXT,
      ADD COLUMN issuance_state TEXT,
      ADD COLUMN execution_domain_json JSONB,
      ADD COLUMN execution_domain_digest TEXT,
      ALTER COLUMN secure_session_id DROP NOT NULL,
      ALTER COLUMN lease_id DROP NOT NULL,
      ALTER COLUMN sandbox_id DROP NOT NULL,
      ALTER COLUMN generation DROP NOT NULL`,
    `ALTER TABLE task_checkouts DROP CONSTRAINT task_checkouts_status_check,
      DROP CONSTRAINT task_checkouts_terminal_fields_check`,
    `ALTER TABLE task_checkouts
      ADD CONSTRAINT task_checkouts_status_check CHECK (status IN ('issuing','ready','active','settled','failed')),
      ADD CONSTRAINT task_checkouts_terminal_fields_check CHECK (
        (status IN ('issuing','ready','active') AND settled_at IS NULL AND failure_code IS NULL) OR
        (status='settled' AND settled_at IS NOT NULL AND failure_code IS NULL) OR
        (status='failed' AND settled_at IS NOT NULL AND failure_code IS NOT NULL)),
      ADD CONSTRAINT task_checkouts_issuance_check CHECK (COALESCE((
        (status='issuing' AND issuance_token IS NOT NULL AND length(issuance_token)>0 AND
          issuance_state IN ('reserved','callback_started','domain_frozen','unknown') AND
          secure_session_id IS NULL AND lease_id IS NULL AND sandbox_id IS NULL AND generation IS NULL) OR
        (status<>'issuing' AND secure_session_id IS NOT NULL AND lease_id IS NOT NULL AND
          sandbox_id IS NOT NULL AND generation IS NOT NULL AND
          ((issuance_state IS NULL AND issuance_token IS NULL AND execution_domain_json IS NULL AND execution_domain_digest IS NULL) OR
           (issuance_state='ready' AND issuance_token IS NOT NULL AND execution_domain_json IS NOT NULL AND execution_domain_digest IS NOT NULL)))), FALSE)),
      ADD CONSTRAINT task_checkouts_execution_domain_check CHECK (COALESCE((
        (execution_domain_json IS NULL AND execution_domain_digest IS NULL AND issuance_state IS DISTINCT FROM 'domain_frozen') OR
        (execution_domain_json IS NOT NULL AND jsonb_typeof(execution_domain_json)='object' AND
          execution_domain_digest IS NOT NULL AND execution_domain_digest ~ '^[a-f0-9]{64}$' AND
          issuance_state IN ('domain_frozen','unknown','ready'))), FALSE))`,
    `CREATE OR REPLACE FUNCTION enforce_task_checkout_transition()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP='INSERT' THEN
          IF (NEW.status='issuing' AND NEW.issuance_state='reserved' AND NEW.execution_domain_json IS NULL) OR
             (NEW.status='ready' AND NEW.issuance_state IS NULL) THEN RETURN NEW; END IF;
          RAISE EXCEPTION 'task checkouts require a fresh issuance reservation or legacy ready binding';
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
           NEW.created_at IS DISTINCT FROM OLD.created_at OR
           NEW.issuance_token IS DISTINCT FROM OLD.issuance_token THEN
          RAISE EXCEPTION 'task checkout binding is immutable';
        END IF;
        IF OLD.status='issuing' THEN
          IF OLD.issuance_state='reserved' AND NEW.issuance_state='callback_started' AND NEW.status='issuing' AND
             NEW.execution_domain_json IS NULL AND NEW.execution_domain_digest IS NULL THEN RETURN NEW; END IF;
          IF OLD.issuance_state='callback_started' AND NEW.issuance_state='domain_frozen' AND NEW.status='issuing' AND
             NEW.execution_domain_json IS NOT NULL AND NEW.execution_domain_digest IS NOT NULL THEN RETURN NEW; END IF;
          IF OLD.issuance_state='domain_frozen' AND NEW.issuance_state='ready' AND NEW.status='ready' AND
             NEW.execution_domain_json IS NOT DISTINCT FROM OLD.execution_domain_json AND
             NEW.execution_domain_digest IS NOT DISTINCT FROM OLD.execution_domain_digest THEN RETURN NEW; END IF;
          IF OLD.issuance_state IN ('reserved','callback_started','domain_frozen') AND NEW.issuance_state='unknown' AND NEW.status='issuing' AND
             NEW.execution_domain_json IS NOT DISTINCT FROM OLD.execution_domain_json AND
             NEW.execution_domain_digest IS NOT DISTINCT FROM OLD.execution_domain_digest THEN RETURN NEW; END IF;
          RAISE EXCEPTION 'task checkout issuance cannot be replayed';
        END IF;
        IF NEW.issuance_state IS DISTINCT FROM OLD.issuance_state OR
           NEW.execution_domain_json IS DISTINCT FROM OLD.execution_domain_json OR
           NEW.execution_domain_digest IS DISTINCT FROM OLD.execution_domain_digest OR
           NEW.secure_session_id IS DISTINCT FROM OLD.secure_session_id THEN
          RAISE EXCEPTION 'task checkout execution domain is immutable';
        END IF;
        IF OLD.issuance_token IS NULL AND OLD.status IN ('ready','active') AND NEW.status=OLD.status AND
           NEW.settled_at IS NULL AND NEW.failure_code IS NULL AND NEW.generation=OLD.generation+1 AND
           NEW.lease_id IS DISTINCT FROM OLD.lease_id AND NEW.sandbox_id IS DISTINCT FROM OLD.sandbox_id THEN RETURN NEW; END IF;
        IF NEW.lease_id IS DISTINCT FROM OLD.lease_id OR NEW.sandbox_id IS DISTINCT FROM OLD.sandbox_id OR
           NEW.generation IS DISTINCT FROM OLD.generation THEN RAISE EXCEPTION 'task checkout lease replacement is invalid'; END IF;
        IF OLD.status='ready' AND NEW.status='active' AND NEW.settled_at IS NULL AND NEW.failure_code IS NULL THEN RETURN NEW; END IF;
        IF OLD.status='active' AND NEW.status='settled' AND NEW.settled_at IS NOT NULL AND NEW.failure_code IS NULL THEN RETURN NEW; END IF;
        IF OLD.status='active' AND NEW.status='failed' AND NEW.settled_at IS NOT NULL AND NEW.failure_code IS NOT NULL THEN RETURN NEW; END IF;
        RAISE EXCEPTION 'task checkout transition is invalid';
      END;
      $$ LANGUAGE plpgsql`,
  ],
};
