import type { SqlMigration } from "./types.js";

export const providerUserModelCacheTextKeyMigration: SqlMigration = {
  id: "0011_provider_user_model_cache_text_key",
  description: "Allow provider user model cache keys to use provider-scoped text identifiers",
  statements: [
    `
      DROP INDEX IF EXISTS provider_user_model_cache_expiry_idx
    `,
    `
      ALTER TABLE provider_user_model_cache
        DROP CONSTRAINT IF EXISTS provider_user_model_cache_credential_id_provider_credentials_id_fk
    `,
    `
      ALTER TABLE provider_user_model_cache
        DROP CONSTRAINT IF EXISTS provider_user_model_cache_credential_id_fkey
    `,
    `
      ALTER TABLE provider_user_model_cache
        DROP CONSTRAINT IF EXISTS provider_user_model_cache_user_provider_credential_pk
    `,
    `
      ALTER TABLE provider_user_model_cache
        DROP CONSTRAINT IF EXISTS provider_user_model_cache_pkey
    `,
    `
      DO $$
      DECLARE
        existing_primary_key_name TEXT;
      BEGIN
        SELECT conname INTO existing_primary_key_name
        FROM pg_constraint
        WHERE conrelid = 'provider_user_model_cache'::regclass
          AND contype = 'p';

        IF existing_primary_key_name IS NOT NULL THEN
          EXECUTE format(
            'ALTER TABLE provider_user_model_cache DROP CONSTRAINT %I',
            existing_primary_key_name
          );
        END IF;
      END
      $$
    `,
    `
      ALTER TABLE provider_user_model_cache
        ALTER COLUMN credential_id TYPE TEXT USING credential_id::text
    `,
    `
      ALTER TABLE provider_user_model_cache
        ADD CONSTRAINT provider_user_model_cache_user_provider_credential_pk
        PRIMARY KEY (user_id, provider_id, credential_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS provider_user_model_cache_expiry_idx
        ON provider_user_model_cache (expires_at)
    `,
  ],
};
