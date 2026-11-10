import { PGlite } from "@electric-sql/pglite";
import { workspaceConfigurationVersionMigration } from "../migrations/0041-workspace-configuration-version.js";
import { workspaceBootstrapMigration } from "../migrations/0003-workspace-bootstrap.js";
import { describe, expect, it } from "vitest";
import type { SqlClient, SqlQueryResult, SqlRow, SqlValue } from "../sql.js";
import { RepositoryIdentityConflictError } from "./types.js";
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
    expect(findQuery(client, "INSERT INTO workspaces").params[0]).toBe(
      "user-1",
    );
    expect(
      findQuery(client, "INSERT INTO workspace_selections").params[1],
    ).toBe("workspace-1");
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

    // Exercise the actual PostgreSQL statements, transaction rollback and CAS,
    // rather than treating the query-capture fake as database proof.
    const db = new PGlite();
    const userId = "550e8400-e29b-41d4-a716-446655440001";
    const otherUser = "550e8400-e29b-41d4-a716-446655440002";
    try {
      await db.exec(
        `CREATE TABLE users (id UUID PRIMARY KEY); INSERT INTO users VALUES ('${userId}'), ('${otherUser}');`,
      );
      for (const statement of workspaceBootstrapMigration.statements)
        await db.exec(statement);
      for (const statement of workspaceConfigurationVersionMigration.statements) await db.exec(statement);
      const sql = new PGliteWorkspaceClient(db);
      const actual = new PostgresWorkspaceRepository(sql);
      const input = {
        userId,
        selectedBranch: "main",
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
      };
      const first = await actual.selectWorkspace(input);
      const workspaceId = first.workspace.id;
      const update = {
        userId,
        workspaceId,
        expectedVersion: 1,
        expectedRepository: { id: first.repository.id, providerRepoId: "123" },
        patch: { name: "Configured", selectedBranch: "saved" },
        now: "2026-05-15T00:00:00.000Z",
      };
      expect(
        await actual.findWorkspaceConfiguration(userId, workspaceId),
      ).toMatchObject({ version: 1 });
      const beforeIdentityConflict = await actual.findWorkspaceSelection(userId);
      const originalRows = await db.query("SELECT * FROM repos ORDER BY id");
      for (const providerRepoId of ["456", null]) {
        await expect(actual.selectWorkspace({ ...input, userId: otherUser, selectedBranch: "blocked", repository: { ...input.repository, providerRepoId, fullName: "must-not-write" } })).rejects.toBeInstanceOf(RepositoryIdentityConflictError);
        expect(await actual.findWorkspaceSelection(userId)).toEqual(beforeIdentityConflict);
        expect(await actual.listWorkspaces(otherUser)).toEqual([]);
        expect(await actual.findWorkspaceSelection(otherUser)).toBeNull();
        expect(await db.query("SELECT * FROM repos ORDER BY id")).toEqual(originalRows);
      }
      const sameIdentity = await actual.selectWorkspace({ ...input, userId: otherUser });
      expect(sameIdentity.repository.id).toBe(first.repository.id);
      expect(await actual.findWorkspaceSelection(userId)).toEqual(beforeIdentityConflict);
      const legacyInput = { ...input, userId: otherUser, repository: { ...input.repository, name: "legacy-null", fullName: "acme/legacy-null", providerRepoId: null } };
      const legacy = await actual.selectWorkspace(legacyInput);
      const savedLegacy = await actual.findWorkspaceSelection(otherUser);
      await expect(actual.selectWorkspace({ ...legacyInput, repository: { ...legacyInput.repository, providerRepoId: "789" } })).rejects.toBeInstanceOf(RepositoryIdentityConflictError);
      await expect(actual.updateWorkspaceConfiguration({ ...update, userId: otherUser, workspaceId: legacy.workspace.id, expectedRepository: { id: legacy.repository.id, providerRepoId: "789" } })).rejects.toBeInstanceOf(RepositoryIdentityConflictError);
      expect(await actual.findWorkspaceSelection(otherUser)).toEqual(savedLegacy);
      // Gate the real transaction entry to mutate caller-owned ingress after
      // invocation. Production must use the selection snapshot taken before await.
      let releaseSelection!: () => void;
      const selectionGate = new Promise<void>((resolve) => { releaseSelection = resolve; });
      const pausedSelect = new PostgresWorkspaceRepository({
        query: sql.query.bind(sql),
        transaction: async (callback) => { await selectionGate; return sql.transaction(callback); },
      });
      const selectionRequest = { ...input, userId: otherUser, selectedBranch: "captured-selection", repository: { ...input.repository } };
      const selecting = pausedSelect.selectWorkspace(selectionRequest);
      selectionRequest.repository.providerRepoId = "456";
      selectionRequest.repository.name = "mutated-namespace";
      selectionRequest.selectedBranch = "mutated-selection";
      releaseSelection();
      expect(await selecting).toMatchObject({ repository: { id: first.repository.id, providerRepoId: "123" }, selection: { selectedBranch: "captured-selection" } });
      const competing = await Promise.all([
        actual.updateWorkspaceConfiguration(update),
        actual.updateWorkspaceConfiguration({
          ...update,
          patch: { name: "Losing write" },
        }),
      ]);
      expect(competing.map((result) => result.status)).toEqual([
        "updated",
        "conflict",
      ]);
      const saved = await actual.findWorkspaceConfiguration(
        userId,
        workspaceId,
      );
      expect(saved).toMatchObject({
        version: 2,
        workspace: { name: "Configured", lastSelectedBranch: "saved" },
      });
      expect(await actual.findWorkspaceSelection(userId)).toMatchObject({
        selection: { selectedBranch: "saved" },
        workspace: { lastSelectedBranch: "saved" },
      });
      expect(await actual.updateWorkspaceConfiguration(update)).toEqual({
        status: "conflict",
      });
      expect(
        await actual.updateWorkspaceConfiguration({
          ...update,
          expectedVersion: 2,
        }),
      ).toEqual({ status: "updated", configuration: saved });
      const reselected = await actual.selectWorkspace({
        ...input,
        selectedBranch: "saved",
      });
      expect(reselected.workspace.name).toBe("Configured");
      expect(
        await actual.findWorkspaceConfiguration(userId, workspaceId),
      ).toMatchObject({ version: 2 });
      await actual.selectWorkspace({ ...input, selectedBranch: "reselected" });
      expect(
        await actual.findWorkspaceConfiguration(userId, workspaceId),
      ).toMatchObject({ version: 3 });
      expect(
        await actual.updateWorkspaceConfiguration({
          ...update,
          expectedVersion: 2,
        }),
      ).toEqual({ status: "conflict" });
      expect(
        await actual.findWorkspaceConfiguration(otherUser, workspaceId),
      ).toBeNull();
      expect(
        await actual.updateWorkspaceConfiguration({
          ...update,
          userId: otherUser,
        }),
      ).toEqual({ status: "not_found" });
      const other = await actual.selectWorkspace({
        ...input,
        repository: {
          ...input.repository,
          name: "other",
          fullName: "acme/other",
        },
        selectedBranch: "other-branch",
      });
      await actual.updateWorkspaceConfiguration({
        ...update,
        expectedVersion: 3,
        patch: { selectedBranch: "unselected" },
      });
      expect(await actual.findWorkspaceSelection(userId)).toMatchObject({
        workspace: { id: other.workspace.id },
        selection: { selectedBranch: "other-branch" },
      });
      // A selection-row failure rolls the workspace mutation/version back too.
      await actual.selectWorkspace({ ...input, selectedBranch: "unselected" });
      await db.exec(
        "ALTER TABLE workspace_selections ADD CONSTRAINT reject_fixture_branch CHECK (selected_branch <> 'rollback-fixture')",
      );
      await expect(
        actual.updateWorkspaceConfiguration({
          ...update,
          expectedVersion: 4,
          patch: { selectedBranch: "rollback-fixture" },
        }),
      ).rejects.toThrow();
      expect(
        await actual.findWorkspaceConfiguration(userId, workspaceId),
      ).toMatchObject({
        version: 4,
        workspace: { lastSelectedBranch: "unselected" },
      });
      // Capture nested patch/binding before an asynchronous transaction entry.
      let releaseUpdate!: () => void;
      const updateGate = new Promise<void>((resolve) => { releaseUpdate = resolve; });
      const pausedUpdate = new PostgresWorkspaceRepository({
        query: sql.query.bind(sql),
        transaction: async (callback) => { await updateGate; return sql.transaction(callback); },
      });
      const mutable = { ...update, expectedVersion: 4, expectedRepository: { ...update.expectedRepository }, patch: { selectedBranch: "captured-input" } };
      const updating = pausedUpdate.updateWorkspaceConfiguration(mutable);
      mutable.userId = otherUser;
      mutable.expectedRepository.id = other.repository.id;
      mutable.expectedRepository.providerRepoId = "456";
      mutable.patch.selectedBranch = "mutated-input";
      releaseUpdate();
      expect(await updating).toMatchObject({ status: "updated", configuration: { version: 5, repository: { id: first.repository.id, providerRepoId: "123" }, workspace: { lastSelectedBranch: "captured-input" } } });
      const identitySnapshot = await actual.findWorkspaceConfiguration(userId, workspaceId);
      for (const expectedRepository of [
        { id: first.repository.id, providerRepoId: "456" },
        { id: other.repository.id, providerRepoId: "123" },
      ]) {
        await expect(actual.updateWorkspaceConfiguration({ ...update, expectedVersion: 0, expectedRepository })).rejects.toBeInstanceOf(RepositoryIdentityConflictError);
        expect(await actual.findWorkspaceConfiguration(userId, workspaceId)).toEqual(identitySnapshot);
      }
      // An intervening out-of-band identity change before lock acquisition is
      // rejected at the actual write boundary, even when version still matches.
      let releaseIntervening!: () => void;
      const interveningGate = new Promise<void>((resolve) => { releaseIntervening = resolve; });
      const intervening = new PostgresWorkspaceRepository({
        query: sql.query.bind(sql),
        transaction: async (callback) => { await interveningGate; return sql.transaction(callback); },
      }).updateWorkspaceConfiguration({ ...update, expectedVersion: 5 });
      await db.query("UPDATE repos SET provider_repo_id = '456' WHERE id = $1", [first.repository.id]);
      releaseIntervening();
      await expect(intervening).rejects.toBeInstanceOf(RepositoryIdentityConflictError);
      expect((await actual.findWorkspaceConfiguration(userId, workspaceId))?.workspace).toEqual(identitySnapshot?.workspace);
      expect((await actual.findWorkspaceConfiguration(userId, workspaceId))?.version).toBe(5);
      await db.query("UPDATE repos SET provider_repo_id = '123' WHERE id = $1", [first.repository.id]);
      const shareIndex = sql.statements.findIndex((statement) => statement.includes("FOR SHARE"));
      const workspaceLockIndex = sql.statements.findIndex((statement) => statement.includes("FOR UPDATE OF workspaces"));
      expect(shareIndex).toBeGreaterThan(-1);
      expect(workspaceLockIndex).toBeGreaterThan(shareIndex);
      await db.query(
        "UPDATE workspaces SET status = 'archived' WHERE id = $1",
        [workspaceId],
      );
      expect(
        await actual.findWorkspaceConfiguration(userId, workspaceId),
      ).toBeNull();
      expect(
        await actual.updateWorkspaceConfiguration({
          ...update,
          expectedVersion: 4,
        }),
      ).toEqual({ status: "not_found" });
      await expect(
        db.query(
          "UPDATE workspaces SET configuration_version = 0 WHERE id = $1",
          [workspaceId],
        ),
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
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
    configuration_version: 1,
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

class PGliteWorkspaceClient implements SqlClient {
  constructor(private readonly db: PGlite, public readonly statements: string[] = []) {}
  async query<Row extends SqlRow = SqlRow>(
    statement: string,
    params: readonly SqlValue[] = [],
  ): Promise<SqlQueryResult<Row>> {
    this.statements.push(statement);
    const result = await this.db.query<Row>(statement, [...params]);
    return {
      rows: result.rows,
      rowCount: result.affectedRows ?? result.rows.length,
    };
  }
  async transaction<T>(
    callback: (client: SqlClient) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction((transaction) =>
      callback(new PGliteWorkspaceClient(transaction as unknown as PGlite, this.statements)),
    );
  }
}
