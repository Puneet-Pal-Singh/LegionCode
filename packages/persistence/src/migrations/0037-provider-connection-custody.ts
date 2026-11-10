import type { SqlMigration } from "./types.js";
export const providerConnectionCustodyMigration: SqlMigration = {
  id: "0037_provider_connection_custody",
  description:
    "Connection-scoped credential generations, explicit defaults and durable absent-default fencing",
  statements: [
    `ALTER TABLE provider_credentials ADD COLUMN auth_owner_generation BIGINT NOT NULL DEFAULT 1 CHECK(auth_owner_generation>0 AND auth_owner_generation<=9007199254740991)`,
    `ALTER TABLE provider_credentials ADD COLUMN token_material_version BIGINT NOT NULL DEFAULT 1 CHECK(token_material_version>0 AND token_material_version<=9007199254740991)`,
    `ALTER TABLE provider_credentials ADD COLUMN credential_kind TEXT NOT NULL DEFAULT 'api_key' CHECK(credential_kind IN ('api_key','oauth','external_reference'))`,
    `ALTER TABLE provider_credentials ADD COLUMN refresh_claim_id TEXT`,
    `ALTER TABLE provider_credentials ADD COLUMN is_default BOOLEAN NOT NULL DEFAULT TRUE`,
    `UPDATE provider_credentials SET is_default=FALSE WHERE deleted_at IS NOT NULL OR status='revoked'`,
    `DROP INDEX provider_credentials_user_provider_idx`,
    `CREATE UNIQUE INDEX provider_credentials_user_provider_default_idx ON provider_credentials(user_id,provider_id) WHERE is_default=TRUE AND deleted_at IS NULL`,
    `CREATE TABLE provider_credential_default_epochs (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider_id TEXT NOT NULL,
      generation BIGINT NOT NULL DEFAULT 1 CHECK(generation>0 AND generation<=9007199254740991),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(user_id,provider_id)
    )`,
    `INSERT INTO provider_credential_default_epochs(user_id,provider_id)
      SELECT DISTINCT user_id,provider_id FROM provider_credentials`,
    `UPDATE provider_preferences AS p SET default_credential_id=c.id
      FROM provider_credentials AS c WHERE p.user_id=c.user_id AND p.default_provider_id=c.provider_id
        AND p.default_credential_id IS NULL AND c.is_default=TRUE AND c.status='connected'
        AND c.deleted_at IS NULL AND c.credential_kind='api_key'`,
  ],
};
