CREATE TABLE IF NOT EXISTS canonical_lifecycle_events (
  event_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  run_attempt_id TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  idempotency_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_json JSONB NOT NULL,
  schema_version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT canonical_lifecycle_events_sequence_check CHECK (sequence > 0),
  CONSTRAINT canonical_lifecycle_events_schema_version_check CHECK (schema_version > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS canonical_lifecycle_events_turn_sequence_idx ON canonical_lifecycle_events (turn_id, sequence);
CREATE UNIQUE INDEX IF NOT EXISTS canonical_lifecycle_events_turn_idempotency_idx ON canonical_lifecycle_events (turn_id, idempotency_key);
CREATE INDEX IF NOT EXISTS canonical_lifecycle_events_thread_created_idx ON canonical_lifecycle_events (thread_id, created_at);
CREATE TABLE IF NOT EXISTS canonical_lifecycle_projections (
  turn_id TEXT PRIMARY KEY,
  last_sequence BIGINT NOT NULL,
  projection_version INTEGER NOT NULL,
  projection_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT canonical_lifecycle_projections_sequence_check CHECK (last_sequence >= 0),
  CONSTRAINT canonical_lifecycle_projections_version_check CHECK (projection_version > 0)
);
