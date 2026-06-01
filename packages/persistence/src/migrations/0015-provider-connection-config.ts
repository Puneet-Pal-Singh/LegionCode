import type { SqlMigration } from "./types.js";

export const providerConnectionConfigMigration: SqlMigration = {
  id: "0015_provider_connection_config",
  description: "Add non-secret provider connection config metadata",
  statements: [
    `
      ALTER TABLE provider_credentials
      ADD COLUMN IF NOT EXISTS connection_config_json JSONB
    `,
  ],
};
