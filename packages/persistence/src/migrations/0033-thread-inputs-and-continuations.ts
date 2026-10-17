import type { SqlMigration } from "./types.js";

/** Durable continuation lineage and queue state. The request path never runs migrations. */
export const threadInputsAndContinuationsMigration: SqlMigration = {
  id: "0033_thread_inputs_and_continuations",
  description: "Persist continuation lineage and scoped thread input inbox",
  statements: [
    `ALTER TABLE canonical_turn_admissions ADD COLUMN IF NOT EXISTS continuation_of_turn_id TEXT`,
    `ALTER TABLE canonical_turn_admissions ADD COLUMN IF NOT EXISTS original_prompt_id TEXT`,
    `ALTER TABLE canonical_turn_admissions ADD COLUMN IF NOT EXISTS continuation_terminal_sequence BIGINT`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'canonical_turn_admissions_continuation_identity_check') THEN ALTER TABLE canonical_turn_admissions ADD CONSTRAINT canonical_turn_admissions_continuation_identity_check CHECK ((continuation_of_turn_id IS NULL AND original_prompt_id IS NULL AND continuation_terminal_sequence IS NULL) OR (continuation_of_turn_id IS NOT NULL AND original_prompt_id IS NOT NULL AND continuation_terminal_sequence IS NOT NULL AND continuation_terminal_sequence > 0)); END IF; END $$`,
    `CREATE INDEX IF NOT EXISTS canonical_turn_admissions_continuation_idx ON canonical_turn_admissions (session_id, continuation_of_turn_id) WHERE continuation_of_turn_id IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS thread_input_state (
      session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL,
      workspace_id UUID NOT NULL,
      revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
      next_order BIGINT NOT NULL DEFAULT 0 CHECK (next_order >= 0),
      paused BOOLEAN NOT NULL DEFAULT FALSE,
      pause_reason TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (session_id),
      UNIQUE (thread_id, workspace_id)
    )`,
    `CREATE TABLE IF NOT EXISTS thread_inputs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      thread_id TEXT NOT NULL,
      workspace_id UUID NOT NULL,
      client_input_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      delivery TEXT NOT NULL CHECK (delivery IN ('queue','steer')),
      target_turn_id TEXT,
      target_run_attempt_id TEXT,
      content_json JSONB NOT NULL,
      configuration_json JSONB NOT NULL,
      order_number BIGINT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','consuming','consumed','cancelled')),
      receipt_json JSONB,
      accepted_sequence BIGINT,
      applied_sequence BIGINT,
      model_step INTEGER,
      context_revision INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      consumed_at TIMESTAMPTZ,
      UNIQUE (thread_id, workspace_id, client_input_id),
      UNIQUE (session_id, order_number),
      CHECK ((delivery = 'steer' AND target_turn_id IS NOT NULL AND target_run_attempt_id IS NOT NULL) OR delivery = 'queue')
    )`,
    `CREATE OR REPLACE FUNCTION bump_thread_input_revision_from_lifecycle() RETURNS trigger AS $$
      DECLARE admission_session UUID;
      BEGIN
        IF NEW.event_type NOT IN ('turn.started','turn.completed','turn.failed','turn.interrupted') THEN
          RETURN NEW;
        END IF;
        SELECT session_id INTO admission_session
        FROM canonical_turn_admissions WHERE turn_id = NEW.turn_id;
        IF admission_session IS NOT NULL THEN
          UPDATE thread_input_state
          SET revision = revision + 1, updated_at = now()
          WHERE session_id = admission_session AND thread_id = NEW.thread_id;
        END IF;
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS canonical_lifecycle_bump_thread_input_revision ON canonical_lifecycle_events`,
    `CREATE TRIGGER canonical_lifecycle_bump_thread_input_revision AFTER INSERT ON canonical_lifecycle_events FOR EACH ROW EXECUTE FUNCTION bump_thread_input_revision_from_lifecycle()`,
    `CREATE OR REPLACE FUNCTION bump_thread_input_revision_from_admission() RETURNS trigger AS $$
      BEGIN
        UPDATE thread_input_state
        SET revision = revision + 1, updated_at = now()
        WHERE session_id = NEW.session_id AND thread_id = NEW.thread_id;
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS turn_admission_bump_thread_input_revision ON canonical_turn_admissions`,
    `CREATE TRIGGER turn_admission_bump_thread_input_revision AFTER INSERT OR UPDATE OF admission_state, execution_state ON canonical_turn_admissions FOR EACH ROW EXECUTE FUNCTION bump_thread_input_revision_from_admission()`,
    `CREATE INDEX IF NOT EXISTS thread_inputs_pending_order_idx ON thread_inputs (session_id, order_number) WHERE state = 'pending'`,
    `CREATE INDEX IF NOT EXISTS thread_inputs_target_pending_idx ON thread_inputs (target_turn_id, target_run_attempt_id, order_number) WHERE state IN ('pending','consuming') AND delivery = 'steer'`,
  ],
};
