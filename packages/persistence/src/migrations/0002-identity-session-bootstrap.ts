import type { SqlMigration } from "./types.js";

export const identitySessionBootstrapMigration: SqlMigration = {
  id: "0002_identity_session_bootstrap",
  description: "Create identity, OAuth account, and auth session tables",
  statements: [
    `
      CREATE EXTENSION IF NOT EXISTS pgcrypto
    `,
    `
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        display_name TEXT,
        avatar_url TEXT,
        primary_email TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen_at TIMESTAMPTZ
      )
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS users_primary_email_idx
        ON users (primary_email)
        WHERE primary_email IS NOT NULL
    `,
    `
      CREATE TABLE IF NOT EXISTS accounts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        provider_account_id TEXT NOT NULL,
        provider_login TEXT NOT NULL,
        provider_email TEXT,
        avatar_url TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS accounts_provider_account_id_idx
        ON accounts (provider, provider_account_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS accounts_user_id_idx
        ON accounts (user_id)
    `,
    `
      CREATE TABLE IF NOT EXISTS auth_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_hash TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen_at TIMESTAMPTZ
      )
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS auth_sessions_session_hash_idx
        ON auth_sessions (session_hash)
    `,
    `
      CREATE INDEX IF NOT EXISTS auth_sessions_user_id_idx
        ON auth_sessions (user_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS auth_sessions_active_idx
        ON auth_sessions (user_id, expires_at)
        WHERE revoked_at IS NULL
    `,
    `
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        encrypted_access_token_json JSONB NOT NULL,
        token_fingerprint TEXT NOT NULL,
        scopes_json JSONB NOT NULL,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS oauth_tokens_user_id_idx
        ON oauth_tokens (user_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS oauth_tokens_account_id_idx
        ON oauth_tokens (account_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS oauth_tokens_provider_fingerprint_idx
        ON oauth_tokens (provider, token_fingerprint)
    `,
  ],
};
