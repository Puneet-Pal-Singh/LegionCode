import type { SqlMigration } from "./types.js";

/** Private original custody only; no bearer, public DTO or alternate registry.
 * Historical Native rows are not backfilled or rebound. Readers reject absence. */
export const taskCheckoutOriginalReferenceMigration: SqlMigration = {
  id: "0044_task_checkout_original_reference",
  description: "Freeze the original Native physical session reference before bootstrap",
  statements: [
    `ALTER TABLE task_checkouts ADD COLUMN original_session_reference_json JSONB`,
    `ALTER TABLE task_checkouts ADD CONSTRAINT task_checkouts_original_reference_check CHECK (COALESCE((
      (original_session_reference_json IS NULL AND (execution_domain_json->>'domain' IS DISTINCT FROM 'legioncode_native' OR status='issuing')) OR
      (jsonb_typeof(original_session_reference_json)='object' AND execution_domain_json->>'domain'='legioncode_native' AND
       original_session_reference_json - ARRAY['secureSessionId','leaseId','sandboxId','generation','executionDomainDigest','nativeSandboxBinding'] = '{}'::jsonb AND
       jsonb_typeof(original_session_reference_json->'secureSessionId')='string' AND length(original_session_reference_json->>'secureSessionId')>0 AND
       jsonb_typeof(original_session_reference_json->'leaseId')='string' AND length(original_session_reference_json->>'leaseId')>0 AND
       jsonb_typeof(original_session_reference_json->'sandboxId')='string' AND length(original_session_reference_json->>'sandboxId')>0 AND
       jsonb_typeof(original_session_reference_json->'generation')='number' AND (original_session_reference_json->>'generation') ~ '^[0-9]+$' AND
       original_session_reference_json->>'executionDomainDigest'=execution_domain_digest AND
       jsonb_typeof(original_session_reference_json->'nativeSandboxBinding')='object' AND
       (original_session_reference_json->'nativeSandboxBinding') - ARRAY['version','backend','binding','profile','schedulingPolicy','sandboxObjectId'] = '{}'::jsonb AND
       original_session_reference_json->'nativeSandboxBinding'->'version'='1'::jsonb AND
       original_session_reference_json->'nativeSandboxBinding'->>'backend'='cloudflareSandbox' AND
       original_session_reference_json->'nativeSandboxBinding'->>'binding'='NativeSandbox' AND
       original_session_reference_json->'nativeSandboxBinding'->>'profile'='basic' AND
       original_session_reference_json->'nativeSandboxBinding'->>'schedulingPolicy'='default' AND
       original_session_reference_json->'nativeSandboxBinding'->>'sandboxObjectId' ~ '^[a-f0-9]{64}$' AND
       (status='issuing' OR (original_session_reference_json->>'secureSessionId'=secure_session_id AND
         original_session_reference_json->>'leaseId'=lease_id AND original_session_reference_json->>'sandboxId'=sandbox_id AND
         (original_session_reference_json->>'generation')::numeric=generation)))), FALSE)) NOT VALID`,
    `CREATE OR REPLACE FUNCTION enforce_task_checkout_transition()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP='INSERT' THEN
          IF NEW.original_session_reference_json IS NOT NULL THEN RAISE EXCEPTION 'original reference requires reserved custody'; END IF;
          IF (NEW.status='issuing' AND NEW.issuance_state='reserved' AND NEW.execution_domain_json IS NULL) OR
             (NEW.status='ready' AND NEW.issuance_state IS NULL) THEN RETURN NEW; END IF;
          RAISE EXCEPTION 'task checkouts require a fresh issuance reservation or legacy ready binding';
        END IF;
        IF OLD.original_session_reference_json IS NOT NULL AND NEW.original_session_reference_json IS DISTINCT FROM OLD.original_session_reference_json THEN
          RAISE EXCEPTION 'original session reference is immutable';
        END IF;
        IF OLD.original_session_reference_json IS NULL AND NEW.original_session_reference_json IS NOT NULL THEN
          IF OLD.status='issuing' AND OLD.issuance_state='domain_frozen' AND OLD.execution_domain_json->>'domain'='legioncode_native' AND
             (to_jsonb(NEW)-'original_session_reference_json') IS NOT DISTINCT FROM (to_jsonb(OLD)-'original_session_reference_json') THEN RETURN NEW; END IF;
          RAISE EXCEPTION 'original session reference cannot be rebound';
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
