/**
 * D1 Schema Definitions for BYOK
 *
 * Defines the SQL schema for credential storage, preferences, and audit events.
 * Supports encryption at rest with key versioning for rotation.
 */

/**
 * D1 Migration: Create BYOK credentials table
 *
 * Stores encrypted API keys with metadata for lifecycle management.
 * Uses soft deletes (deletedAt) to support recovery and auditing.
 *
 * IMPORTANT: Credentials are user-global (keyed by user_id, not workspace_id).
 * workspace_id is retained as descriptive metadata for workspace-aware UX.
 */
export const BYOK_CREDENTIALS_SCHEMA = `
CREATE TABLE IF NOT EXISTS byok_credentials (
  credential_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  label TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  encrypted_secret_json TEXT NOT NULL,
  key_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected',
  last_validated_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

-- User-global unique index: (user_id, provider_id, label)
-- This replaces the old workspace-scoped index
CREATE UNIQUE INDEX IF NOT EXISTS uq_byok_cred_user_provider_label
  ON byok_credentials(user_id, provider_id, label)
  WHERE deleted_at IS NULL;

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS ix_byok_cred_user_provider
  ON byok_credentials(user_id, provider_id);

CREATE INDEX IF NOT EXISTS ix_byok_cred_user_status
  ON byok_credentials(user_id, status);

CREATE INDEX IF NOT EXISTS ix_byok_cred_created_at
  ON byok_credentials(created_at DESC);
`;

/**
 * Migration to replace workspace-scoped index with user-global index
 * Only needed for existing databases, new installs get the index from BYOK_CREDENTIALS_SCHEMA
 */
export const MIGRATION_USER_GLOBAL_CREDENTIAL_INDEX = `
-- Drop old workspace-scoped index if it exists
DROP INDEX IF EXISTS uq_byok_cred_scope_label;

-- User-global unique index already created in BYOK_CREDENTIALS_SCHEMA
-- This migration file exists for reference only
`;

/**
 * D1 Migration: Create BYOK preferences table
 *
 * Stores workspace-level provider selection state and related UI metadata.
 * Primary key is (user_id, workspace_id) for one set of prefs per workspace.
 */
export const BYOK_PREFERENCES_SCHEMA = `
CREATE TABLE IF NOT EXISTS byok_preferences (
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  default_provider_id TEXT,
  default_credential_id TEXT,
  default_model_id TEXT,
  fallback_mode TEXT NOT NULL DEFAULT 'strict',
  fallback_json TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, workspace_id)
);
`;

/**
 * D1 Migration: Create BYOK audit events table
 *
 * Immutable audit trail for compliance and debugging.
 * Records connect, validate, disconnect, preference updates, and resolution events.
 */
export const BYOK_AUDIT_EVENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS byok_audit_events (
  event_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  provider_id TEXT,
  credential_id TEXT,
  operation TEXT NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_byok_audit_scope_time
  ON byok_audit_events(user_id, workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_byok_audit_operation
  ON byok_audit_events(operation, created_at DESC);
`;

/**
 * D1 Migration: Create Axis quota table
 *
 * Stores per-scope daily quota usage in D1 instead of DO-local provider state.
 */
export const PROVIDER_AXIS_QUOTA_SCHEMA = `
CREATE TABLE IF NOT EXISTS provider_axis_quota (
  quota_key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_provider_axis_quota_updated_at
  ON provider_axis_quota(updated_at DESC);
`;

/**
 * D1 Migration: Create provider registry cache table
 *
 * Caches provider metadata to reduce remote fetches.
 * Used to cache discovered provider metadata and reduce repeated remote fetches.
 */
export const PROVIDER_REGISTRY_CACHE_SCHEMA = `
CREATE TABLE IF NOT EXISTS provider_registry_cache (
  provider_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  auth_modes_json TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  models_json TEXT NOT NULL,
  source_version TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  refreshed_at TEXT NOT NULL
);
`;

/**
 * D1 Migration: Create user-scoped provider model cache table
 *
 * Stores inventory responses whose availability depends on the connected
 * credential, such as OpenRouter's /models/user endpoint.
 */
export const PROVIDER_USER_MODEL_CACHE_SCHEMA = `
CREATE TABLE IF NOT EXISTS provider_user_model_cache (
  provider_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  models_json TEXT NOT NULL,
  source_version TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (provider_id, credential_id)
);
`;

/**
 * D1 Migration: Backfill user-scoped provider model cache table
 *
 * This is intentionally duplicated as a tail migration because an earlier
 * local-only migration ordering bug could record the migration id without ever
 * creating the table. Keeping this as a new append-only migration lets older
 * local databases self-heal safely.
 */
export const PROVIDER_USER_MODEL_CACHE_BACKFILL_SCHEMA = `
CREATE TABLE IF NOT EXISTS provider_user_model_cache (
  provider_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  models_json TEXT NOT NULL,
  source_version TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (provider_id, credential_id)
);
`;

/**
 * D1 Migration: Add fetched_at and expires_at to provider registry cache
 *
 * Adds columns for tracking cache freshness and TTL.
 */
export const ADD_FETCH_EXPIRY_TO_CACHE_SCHEMA = `
ALTER TABLE provider_registry_cache
ADD COLUMN fetched_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';

ALTER TABLE provider_registry_cache
ADD COLUMN expires_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
`;

/**
 * D1 Migration: Add visible model IDs to preferences
 *
 * Adds column to persist per-provider model visibility curation.
 * New column is nullable for existing rows that predate this migration.
 * Default: empty JSON object for new preferences.
 */
export const ADD_VISIBLE_MODEL_IDS_TO_PREFERENCES_SCHEMA = `
ALTER TABLE byok_preferences
ADD COLUMN visible_model_ids_json TEXT DEFAULT '{}'
`;

/**
 * D1 Migration: Add credential labels to preferences
 *
 * Adds column to persist per-credential labels for BYOK UI.
 * Maps credential_id -> label for display purposes.
 * Default: empty JSON object for new preferences.
 */
export const ADD_CREDENTIAL_LABELS_TO_PREFERENCES_SCHEMA = `
ALTER TABLE byok_preferences
ADD COLUMN credential_labels_json TEXT DEFAULT '{}'
`;

/**
 * D1 Migration: Schema migration ledger
 *
 * Tracks which migrations have been applied to prevent re-running.
 */
export const BYOK_SCHEMA_MIGRATIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS byok_schema_migrations (
  migration_id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
`;

/**
 * All migrations to run on D1 initialization
 */
export const ALL_BYOK_MIGRATIONS = [
  BYOK_SCHEMA_MIGRATIONS_SCHEMA,
  BYOK_CREDENTIALS_SCHEMA,
  MIGRATION_USER_GLOBAL_CREDENTIAL_INDEX,
  BYOK_PREFERENCES_SCHEMA,
  BYOK_AUDIT_EVENTS_SCHEMA,
  PROVIDER_AXIS_QUOTA_SCHEMA,
  PROVIDER_REGISTRY_CACHE_SCHEMA,
  ADD_FETCH_EXPIRY_TO_CACHE_SCHEMA,
  ADD_VISIBLE_MODEL_IDS_TO_PREFERENCES_SCHEMA,
  ADD_CREDENTIAL_LABELS_TO_PREFERENCES_SCHEMA,
  // Append-only: new migrations must be added at the tail so existing
  // byok_migration_<index> ledger entries stay stable across deploys.
  PROVIDER_USER_MODEL_CACHE_SCHEMA,
  PROVIDER_USER_MODEL_CACHE_BACKFILL_SCHEMA,
];
