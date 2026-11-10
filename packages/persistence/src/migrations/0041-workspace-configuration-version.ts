import type { SqlMigration } from "./types.js";

/** Saved settings on the existing primary-repository workspace, not a machine. */
export const workspaceConfigurationVersionMigration: SqlMigration = {
  id: "0041_workspace_configuration_version",
  description: "Add optimistic concurrency for existing workspace configuration",
  statements: [
    `ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS configuration_version INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE workspaces ADD CONSTRAINT workspaces_configuration_version_positive_check CHECK (configuration_version > 0)`,
  ],
};
