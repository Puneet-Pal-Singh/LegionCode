import { describe, expect, it } from "vitest";
import type { SqlClient, SqlQueryResult, SqlRow, SqlValue } from "../sql.js";
import { PostgresWorkspaceRepository } from "./PostgresWorkspaceRepository.js";

class WorkspaceSqlClient implements SqlClient {
  public readonly queries: Array<{
    statement: string;
    params: readonly SqlValue[];
  }> = [];

  constructor(private readonly options: { status?: string } = {}) {}

  async query<Row extends SqlRow = SqlRow>(
    statement: string,
    params?: readonly SqlValue[],
  ): Promise<SqlQueryResult<Row>> {
    this.queries.push({ statement, params: params ?? [] });

    if (statement.includes("INSERT INTO repos")) {
      return rows([createRepoRow()]);
    }

    if (statement.includes("INSERT INTO workspaces")) {
      return rows([createWorkspaceRow(this.options)]);
    }

    if (statement.includes("INSERT INTO workspace_selections")) {
      return rows([createSelectionRow()]);
    }

    if (statement.includes("FROM workspace_selections")) {
      return rows([
        {
          ...createRepoRow(),
          ...createWorkspaceRow(this.options),
          ...createSelectionRow(),
        },
      ]);
    }

    if (statement.includes("FROM workspaces")) {
      return rows([
        {
          ...createRepoRow(),
          ...createWorkspaceRow(this.options),
          selected_workspace_id: "workspace-1",
        },
      ]);
    }

    return rows([]);
  }

  async transaction<T>(
    callback: (client: SqlClient) => Promise<T>,
  ): Promise<T> {
    return await callback(this);
  }
}

describe("PostgresWorkspaceRepository", () => {
  it("upserts repository, workspace, and selection in one transaction", async () => {
    const client = new WorkspaceSqlClient();
    const repository = new PostgresWorkspaceRepository(client);

    const selected = await repository.selectWorkspace({
      userId: "user-1",
      selectedBranch: "dev",
      now: "2026-05-14T00:00:00.000Z",
      repository: {
        provider: "github",
        owner: "acme",
        name: "legioncode",
        fullName: "acme/legioncode",
        repoUrl: "https://github.com/acme/legioncode",
        defaultBranch: "main",
        providerRepoId: "123",
        now: "2026-05-14T00:00:00.000Z",
      },
    });

    expect(selected.repository.id).toBe("repo-1");
    expect(selected.workspace.id).toBe("workspace-1");
    expect(selected.selection.selectedBranch).toBe("dev");
    expect(findQuery(client, "INSERT INTO repos").params[0]).toBe("github");
    expect(findQuery(client, "INSERT INTO workspaces").params[0]).toBe("user-1");
    expect(findQuery(client, "INSERT INTO workspace_selections").params[1]).toBe(
      "workspace-1",
    );
  });

  it("hydrates the selected workspace and workspace list", async () => {
    const client = new WorkspaceSqlClient();
    const repository = new PostgresWorkspaceRepository(client);

    const selected = await repository.findWorkspaceSelection("user-1");
    const workspaces = await repository.listWorkspaces("user-1");
    const selectionQuery = findQuery(client, "FROM workspace_selections");
    const workspaceListQuery = findQuery(client, "FROM workspaces");

    expect(selected?.workspace.id).toBe("workspace-1");
    expect(selectionQuery.statement).toContain("repos.id AS repo_id");
    expect(selectionQuery.statement).toContain("workspaces.id AS workspace_id");
    expect(workspaceListQuery.statement).toContain("repos.id AS repo_id");
    expect(workspaceListQuery.statement).toContain(
      "workspaces.id AS workspace_id",
    );
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]?.selected).toBe(true);
  });

  it("fails fast on unsupported workspace statuses", async () => {
    const client = new WorkspaceSqlClient({ status: "deleted" });
    const repository = new PostgresWorkspaceRepository(client);

    await expect(repository.listWorkspaces("user-1")).rejects.toThrow(
      "Unsupported workspace status: deleted",
    );
  });
});

function findQuery(
  client: WorkspaceSqlClient,
  pattern: string,
): { statement: string; params: readonly SqlValue[] } {
  const query = client.queries.find((entry) =>
    entry.statement.includes(pattern),
  );
  if (!query) {
    throw new Error(`Missing query: ${pattern}`);
  }
  return query;
}

function createRepoRow(): SqlRow {
  return {
    repo_id: "repo-1",
    provider: "github",
    owner: "acme",
    repo_name: "legioncode",
    full_name: "acme/legioncode",
    repo_url: "https://github.com/acme/legioncode",
    repo_default_branch: "main",
    provider_repo_id: "123",
    repo_created_at: "2026-05-14T00:00:00.000Z",
    repo_updated_at: "2026-05-14T00:00:00.000Z",
  };
}

function createWorkspaceRow(options: { status?: string } = {}): SqlRow {
  return {
    workspace_id: "workspace-1",
    user_id: "user-1",
    repo_id: "repo-1",
    workspace_name: "acme/legioncode",
    workspace_default_branch: "main",
    last_selected_branch: "dev",
    status: options.status ?? "active",
    workspace_created_at: "2026-05-14T00:00:00.000Z",
    workspace_updated_at: "2026-05-14T00:00:00.000Z",
    last_opened_at: "2026-05-14T00:00:00.000Z",
  };
}

function createSelectionRow(): SqlRow {
  return {
    user_id: "user-1",
    selected_workspace_id: "workspace-1",
    selected_repo_id: "repo-1",
    selected_branch: "dev",
    selection_updated_at: "2026-05-14T00:00:00.000Z",
  };
}

function rows<Row extends SqlRow>(rows: Row[]): SqlQueryResult<Row> {
  return { rows, rowCount: rows.length };
}
