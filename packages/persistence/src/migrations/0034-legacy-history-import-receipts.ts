import type { SqlMigration } from "./types.js";

/** Retains fixed-inventory recovery provenance beside the canonical transcript. */
export const legacyHistoryImportReceiptsMigration: SqlMigration = {
  id: "0034_legacy_history_import_receipts",
  description: "Record provenance for approved legacy transcript imports",
  statements: [
    `CREATE UNIQUE INDEX IF NOT EXISTS sessions_id_user_id_unique_idx ON sessions (id, user_id)`,
    `CREATE TABLE IF NOT EXISTS legacy_history_import_receipts (
      source_environment TEXT NOT NULL,
      source_namespace TEXT NOT NULL,
      source_do_id TEXT NOT NULL,
      source_storage_key TEXT NOT NULL,
      inventory_sha256 TEXT NOT NULL CHECK (inventory_sha256 ~ '^[0-9a-f]{64}$'),
      inventory_cutoff TIMESTAMPTZ NOT NULL,
      source_sha256 TEXT NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
      github_subject TEXT NOT NULL CHECK (github_subject = '46601256'),
      user_id UUID NOT NULL,
      session_id UUID NOT NULL,
      destination_refs JSONB NOT NULL,
      source_created_at TIMESTAMPTZ,
      source_raw BYTEA NOT NULL,
      imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT legacy_history_import_receipts_source_unique
        UNIQUE (source_environment, source_namespace, source_do_id, source_storage_key),
      CONSTRAINT legacy_history_import_receipts_owned_session_fk
        FOREIGN KEY (session_id, user_id) REFERENCES sessions (id, user_id) ON DELETE RESTRICT
    )`,
  ],
};
