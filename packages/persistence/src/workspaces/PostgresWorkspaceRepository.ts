import type { SqlClient, SqlRow } from "../sql.js";
import type {
  RepositoryRecord,
  SelectWorkspaceInput,
  WorkspaceBootstrapRecord,
  WorkspaceListItem,
  WorkspaceRecord,
  WorkspaceRepository,
  WorkspaceSelectionRecord,
} from "./types.js";

interface WorkspaceSelectionRow extends SqlRow {
  repo_id: string;
  provider: string;
  owner: string;
  repo_name: string;
  full_name: string;
  repo_url: string;
  repo_default_branch: string;
  provider_repo_id: string | null;
  repo_created_at: string | Date;
  repo_updated_at: string | Date;
  workspace_id: string;
  user_id: string;
  workspace_name: string;
  workspace_default_branch: string;
  last_selected_branch: string;
  status: string;
  workspace_created_at: string | Date;
  workspace_updated_at: string | Date;
  last_opened_at: string | Date;
  selected_workspace_id?: string;
  selected_repo_id?: string;
  selected_branch?: string;
  selection_updated_at?: string | Date;
}

export class PostgresWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly client: SqlClient) {}

  async selectWorkspace(
    input: SelectWorkspaceInput,
  ): Promise<WorkspaceBootstrapRecord> {
    return await this.client.transaction(async (tx) => {
      const repository = await upsertRepository(tx, input);
      const workspace = await upsertWorkspace(tx, input, repository);
      const selection = await upsertWorkspaceSelection(
        tx,
        input,
        repository,
        workspace,
      );
      return { repository, workspace, selection };
    });
  }

  async findWorkspaceSelection(
    userId: string,
  ): Promise<WorkspaceBootstrapRecord | null> {
    const result = await this.client.query<WorkspaceSelectionRow>(
      FIND_WORKSPACE_SELECTION_SQL,
      [userId],
    );
    const row = result.rows[0];
    return row ? mapBootstrapRow(row) : null;
  }

  async listWorkspaces(userId: string): Promise<WorkspaceListItem[]> {
    const result = await this.client.query<WorkspaceSelectionRow>(
      LIST_WORKSPACES_SQL,
      [userId],
    );
    return result.rows.map(mapWorkspaceListRow);
  }
}

async function upsertRepository(
  client: SqlClient,
  input: SelectWorkspaceInput,
): Promise<RepositoryRecord> {
  const result = await client.query<WorkspaceSelectionRow>(
    UPSERT_REPOSITORY_SQL,
    [
      input.repository.provider,
      input.repository.owner,
      input.repository.name,
      input.repository.fullName,
      input.repository.repoUrl,
      input.repository.defaultBranch,
      input.repository.providerRepoId ?? null,
      input.repository.now,
    ],
  );
  return mapRepositoryRow(readReturnedRow(result.rows[0], "repos"));
}

async function upsertWorkspace(
  client: SqlClient,
  input: SelectWorkspaceInput,
  repository: RepositoryRecord,
): Promise<WorkspaceRecord> {
  const result = await client.query<WorkspaceSelectionRow>(
    UPSERT_WORKSPACE_SQL,
    [
      input.userId,
      repository.id,
      input.workspaceName ?? repository.fullName,
      repository.defaultBranch,
      input.selectedBranch,
      input.now,
    ],
  );
  return mapWorkspaceRow(readReturnedRow(result.rows[0], "workspaces"));
}

async function upsertWorkspaceSelection(
  client: SqlClient,
  input: SelectWorkspaceInput,
  repository: RepositoryRecord,
  workspace: WorkspaceRecord,
): Promise<WorkspaceSelectionRecord> {
  const result = await client.query<WorkspaceSelectionRow>(
    UPSERT_WORKSPACE_SELECTION_SQL,
    [input.userId, workspace.id, repository.id, input.selectedBranch, input.now],
  );
  return mapSelectionRow(
    readReturnedRow(result.rows[0], "workspace_selections"),
  );
}

function mapBootstrapRow(row: WorkspaceSelectionRow): WorkspaceBootstrapRecord {
  return {
    repository: mapRepositoryRow(row),
    workspace: mapWorkspaceRow(row),
    selection: mapSelectionRow(row),
  };
}

function mapWorkspaceListRow(row: WorkspaceSelectionRow): WorkspaceListItem {
  return {
    repository: mapRepositoryRow(row),
    workspace: mapWorkspaceRow(row),
    selected: row.selected_workspace_id === row.workspace_id,
  };
}

function mapRepositoryRow(row: WorkspaceSelectionRow): RepositoryRecord {
  return {
    id: row.repo_id,
    provider: row.provider,
    owner: row.owner,
    name: row.repo_name,
    fullName: row.full_name,
    repoUrl: row.repo_url,
    defaultBranch: row.repo_default_branch,
    providerRepoId: row.provider_repo_id,
    createdAt: toIsoString(row.repo_created_at),
    updatedAt: toIsoString(row.repo_updated_at),
  };
}

function mapWorkspaceRow(row: WorkspaceSelectionRow): WorkspaceRecord {
  return {
    id: row.workspace_id,
    userId: row.user_id,
    repoId: row.repo_id,
    name: row.workspace_name,
    defaultBranch: row.workspace_default_branch,
    lastSelectedBranch: row.last_selected_branch,
    status: mapWorkspaceStatus(row.status),
    createdAt: toIsoString(row.workspace_created_at),
    updatedAt: toIsoString(row.workspace_updated_at),
    lastOpenedAt: toIsoString(row.last_opened_at),
  };
}

function mapWorkspaceStatus(status: string): WorkspaceRecord["status"] {
  if (status === "active" || status === "archived") {
    return status;
  }

  throw new Error(`Unsupported workspace status: ${status}`);
}

function mapSelectionRow(row: WorkspaceSelectionRow): WorkspaceSelectionRecord {
  return {
    userId: row.user_id,
    selectedWorkspaceId: row.selected_workspace_id ?? row.workspace_id,
    selectedRepoId: row.selected_repo_id ?? row.repo_id,
    selectedBranch: row.selected_branch ?? row.last_selected_branch,
    updatedAt: toIsoString(row.selection_updated_at ?? row.workspace_updated_at),
  };
}

function readReturnedRow(
  row: WorkspaceSelectionRow | undefined,
  tableName: string,
): WorkspaceSelectionRow {
  if (!row) {
    throw new Error(`${tableName} upsert returned no row`);
  }
  return row;
}

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

const REPOSITORY_COLUMNS = `
  repos.id AS repo_id,
  repos.provider,
  repos.owner,
  repos.name AS repo_name,
  repos.full_name,
  repos.repo_url,
  repos.default_branch AS repo_default_branch,
  repos.provider_repo_id,
  repos.created_at AS repo_created_at,
  repos.updated_at AS repo_updated_at
`;

const WORKSPACE_COLUMNS = `
  workspaces.id AS workspace_id,
  workspaces.user_id,
  workspaces.repo_id,
  workspaces.name AS workspace_name,
  workspaces.default_branch AS workspace_default_branch,
  workspaces.last_selected_branch,
  workspaces.status,
  workspaces.created_at AS workspace_created_at,
  workspaces.updated_at AS workspace_updated_at,
  workspaces.last_opened_at
`;

const UPSERT_REPOSITORY_SQL = `
  INSERT INTO repos (
    provider,
    owner,
    name,
    full_name,
    repo_url,
    default_branch,
    provider_repo_id,
    created_at,
    updated_at
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
  ON CONFLICT (provider, owner, name)
  DO UPDATE SET
    full_name = EXCLUDED.full_name,
    repo_url = EXCLUDED.repo_url,
    default_branch = EXCLUDED.default_branch,
    provider_repo_id = EXCLUDED.provider_repo_id,
    updated_at = EXCLUDED.updated_at
  RETURNING ${REPOSITORY_COLUMNS}
`;

const UPSERT_WORKSPACE_SQL = `
  INSERT INTO workspaces (
    user_id,
    repo_id,
    name,
    default_branch,
    last_selected_branch,
    status,
    created_at,
    updated_at,
    last_opened_at
  )
  VALUES ($1, $2, $3, $4, $5, 'active', $6, $6, $6)
  ON CONFLICT (user_id, repo_id)
  DO UPDATE SET
    name = EXCLUDED.name,
    default_branch = EXCLUDED.default_branch,
    last_selected_branch = EXCLUDED.last_selected_branch,
    status = 'active',
    updated_at = EXCLUDED.updated_at,
    last_opened_at = EXCLUDED.last_opened_at
  RETURNING ${WORKSPACE_COLUMNS}
`;

const UPSERT_WORKSPACE_SELECTION_SQL = `
  INSERT INTO workspace_selections (
    user_id,
    selected_workspace_id,
    selected_repo_id,
    selected_branch,
    updated_at
  )
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (user_id)
  DO UPDATE SET
    selected_workspace_id = EXCLUDED.selected_workspace_id,
    selected_repo_id = EXCLUDED.selected_repo_id,
    selected_branch = EXCLUDED.selected_branch,
    updated_at = EXCLUDED.updated_at
  RETURNING
    workspace_selections.user_id,
    workspace_selections.selected_workspace_id,
    workspace_selections.selected_repo_id,
    workspace_selections.selected_branch,
    workspace_selections.updated_at AS selection_updated_at
`;

const FIND_WORKSPACE_SELECTION_SQL = `
  SELECT
    ${REPOSITORY_COLUMNS},
    ${WORKSPACE_COLUMNS},
    workspace_selections.selected_workspace_id,
    workspace_selections.selected_repo_id,
    workspace_selections.selected_branch,
    workspace_selections.updated_at AS selection_updated_at
  FROM workspace_selections
  INNER JOIN workspaces
    ON workspaces.id = workspace_selections.selected_workspace_id
  INNER JOIN repos
    ON repos.id = workspace_selections.selected_repo_id
  WHERE workspace_selections.user_id = $1
  LIMIT 1
`;

const LIST_WORKSPACES_SQL = `
  SELECT
    ${REPOSITORY_COLUMNS},
    ${WORKSPACE_COLUMNS},
    workspace_selections.selected_workspace_id
  FROM workspaces
  INNER JOIN repos ON repos.id = workspaces.repo_id
  LEFT JOIN workspace_selections
    ON workspace_selections.user_id = workspaces.user_id
  WHERE workspaces.user_id = $1
  ORDER BY workspaces.updated_at DESC
`;
