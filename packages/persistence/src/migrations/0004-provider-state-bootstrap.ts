import {
  buildProviderAuditEventTypeSqlList,
  buildProviderAuditStatusSqlList,
  buildProviderCredentialStatusSqlList,
} from "../providers/types.js";
import type { SqlMigration } from "./types.js";

const PROVIDER_CREDENTIAL_STATUS_SQL_LIST =
  buildProviderCredentialStatusSqlList();
const PROVIDER_AUDIT_EVENT_TYPE_SQL_LIST = buildProviderAuditEventTypeSqlList();
const PROVIDER_AUDIT_STATUS_SQL_LIST = buildProviderAuditStatusSqlList();

export const providerStateBootstrapMigration: SqlMigration = {
  id: "0004_provider_state_bootstrap",
  description:
    "Create provider credential, preference, audit, and cache tables",
  statements: [
    `
      CREATE TABLE IF NOT EXISTS provider_credentials (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id UUID NOT NULL,
        provider_id TEXT NOT NULL,
        label TEXT NOT NULL,
        key_fingerprint TEXT NOT NULL,
        encrypted_secret_json JSONB NOT NULL,
        key_version TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'connected',
        last_validated_at TIMESTAMPTZ,
        last_error_code TEXT,
        last_error_message TEXT,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        deleted_at TIMESTAMPTZ,
        CONSTRAINT provider_credentials_status_check
          CHECK (status IN (${PROVIDER_CREDENTIAL_STATUS_SQL_LIST}))
      )
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS provider_credentials_user_provider_idx
        ON provider_credentials (user_id, provider_id)
        WHERE deleted_at IS NULL
    `,
    `
      CREATE INDEX IF NOT EXISTS provider_credentials_user_status_idx
        ON provider_credentials (user_id, status)
    `,
    `
      CREATE INDEX IF NOT EXISTS provider_credentials_created_at_idx
        ON provider_credentials (created_at DESC)
    `,
    `
      CREATE TABLE IF NOT EXISTS provider_preferences (
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        default_provider_id TEXT,
        default_credential_id UUID,
        default_model_id TEXT,
        fallback_mode TEXT NOT NULL DEFAULT 'strict',
        fallback_json JSONB,
        visible_model_ids_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        credential_labels_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, workspace_id)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS provider_audit_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        workspace_id UUID NOT NULL,
        provider_id TEXT,
        credential_id UUID,
        operation TEXT NOT NULL,
        status TEXT NOT NULL,
        error_code TEXT,
        metadata_json TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT provider_audit_events_type_check
          CHECK (operation IN (${PROVIDER_AUDIT_EVENT_TYPE_SQL_LIST})),
        CONSTRAINT provider_audit_events_status_check
          CHECK (status IN (${PROVIDER_AUDIT_STATUS_SQL_LIST}))
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS provider_audit_events_scope_time_idx
        ON provider_audit_events (user_id, workspace_id, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS provider_audit_events_type_time_idx
        ON provider_audit_events (operation, created_at DESC)
    `,
    `
      CREATE TABLE IF NOT EXISTS provider_axis_quota (
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        day_key TEXT NOT NULL,
        usage_count INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, workspace_id, day_key)
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS provider_axis_quota_updated_at_idx
        ON provider_axis_quota (updated_at DESC)
    `,
    `
      CREATE TABLE IF NOT EXISTS provider_registry_cache (
        provider_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        auth_modes_json JSONB NOT NULL,
        capabilities_json JSONB NOT NULL,
        models_json JSONB NOT NULL,
        source_version TEXT NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        refreshed_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS provider_user_model_cache (
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL,
        credential_id UUID NOT NULL REFERENCES provider_credentials(id) ON DELETE CASCADE,
        models_json JSONB NOT NULL,
        source_version TEXT NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (user_id, provider_id, credential_id)
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS provider_user_model_cache_expiry_idx
        ON provider_user_model_cache (expires_at)
    `,
  ],
};
