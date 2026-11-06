import type { SqlMigration } from "./types.js";

export const harnessBindingsMigration: SqlMigration = {
  id: "0035_harness_bindings",
  description:
    "Freeze admitted harness selection and atomically receipt canonical observation appends",
  statements: [
    `CREATE TABLE harness_bindings (
      turn_id TEXT PRIMARY KEY REFERENCES canonical_turn_admissions(turn_id) ON DELETE CASCADE,
      run_attempt_id TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      selection_json JSONB NOT NULL,
      selection_fingerprint TEXT NOT NULL,
      attachment_json JSONB,
      external_turn_id TEXT,
      last_observation_sequence BIGINT NOT NULL DEFAULT 0 CHECK(last_observation_sequence >= 0)
    )`,
    `CREATE TABLE harness_process_generations (
      turn_id TEXT NOT NULL REFERENCES harness_bindings(turn_id) ON DELETE CASCADE,
      process_generation TEXT NOT NULL CHECK(length(process_generation) = 36),
      origin_json JSONB NOT NULL,
      PRIMARY KEY(turn_id, process_generation)
    )`,
    `CREATE TABLE harness_observation_receipts (
      turn_id TEXT NOT NULL REFERENCES harness_bindings(turn_id) ON DELETE CASCADE,
      process_generation TEXT NOT NULL CHECK(length(process_generation) = 36),
      sequence BIGINT NOT NULL CHECK(sequence > 0),
      observation_fingerprint TEXT NOT NULL,
      event_ids_json JSONB NOT NULL,
      PRIMARY KEY(turn_id, process_generation, sequence)
    )`,
  ],
};
