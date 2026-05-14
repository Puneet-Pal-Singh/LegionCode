import { buildWorkspaceStatusSqlList } from "../workspaces/types.js";
import type { SqlMigration } from "./types.js";

const WORKSPACE_STATUS_SQL_LIST = buildWorkspaceStatusSqlList();

export const workspaceBootstrapMigration: SqlMigration = {
  id: "0003_workspace_bootstrap",
  description: "Create repository, workspace, and workspace selection tables",
  statements: [
    `
      CREATE TABLE IF NOT EXISTS repos (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        provider TEXT NOT NULL,
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        full_name TEXT NOT NULL,
        repo_url TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        provider_repo_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS repos_provider_owner_name_idx
        ON repos (provider, owner, name)
    `,
    `
      CREATE TABLE IF NOT EXISTS workspaces (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        repo_id UUID NOT NULL REFERENCES repos(id),
        name TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        last_selected_branch TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT workspaces_status_check
          CHECK (status IN (${WORKSPACE_STATUS_SQL_LIST}))
      )
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS workspaces_user_repo_idx
        ON workspaces (user_id, repo_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS workspaces_user_updated_at_idx
        ON workspaces (user_id, updated_at)
    `,
    `
      CREATE INDEX IF NOT EXISTS workspaces_repo_id_idx
        ON workspaces (repo_id)
    `,
    `
      CREATE TABLE IF NOT EXISTS workspace_selections (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        selected_workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        selected_repo_id UUID NOT NULL REFERENCES repos(id),
        selected_branch TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS workspace_selections_workspace_id_idx
        ON workspace_selections (selected_workspace_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS workspace_selections_repo_id_idx
        ON workspace_selections (selected_repo_id)
    `,
  ],
};
