import { registerWorkspaceRepositoryConformance } from "@repo/contract-conformance";
import type { WorkspaceManifest } from "@repo/workspace-core";
import { describe, expect, it } from "vitest";
import type { SqlClient, SqlQueryResult, SqlRow, SqlValue } from "../sql.js";
import { PostgresWorkspaceManifestRepository } from "./PostgresWorkspaceManifestRepository.js";

interface ManifestRow extends SqlRow {
  workspace_id: string;
  run_id: string;
  repo_owner: string;
  repo_name: string;
  repo_url: string;
  base_branch: string;
  working_branch: string;
  base_sha: string;
  head_sha: string;
  execution_location: string;
  worker_id: string;
  filesystem_root: string;
  artifact_namespace: string;
  permission_profile_id: string;
  state: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

class ManifestSqlClient implements SqlClient {
  private rowsByWorkspace = new Map<string, ManifestRow>();

  async query<Row extends SqlRow = SqlRow>(
    statement: string,
    params: readonly SqlValue[] = [],
  ): Promise<SqlQueryResult<Row>> {
    if (statement.startsWith("INSERT INTO workspace_manifests")) {
      const row = createRow(params);
      if (this.rowsByWorkspace.has(row.workspace_id)) {
        throw { code: "23505", constraint: "workspace_manifests_pkey" };
      }
      this.rowsByWorkspace.set(row.workspace_id, row);
      return rows<Row>([row]);
    }
    if (statement.startsWith("UPDATE workspace_manifests")) {
      const row = createRow(params);
      this.rowsByWorkspace.set(row.workspace_id, row);
      return rows<Row>([row]);
    }
    if (statement.includes("WHERE workspace_id=$1")) {
      const row = this.rowsByWorkspace.get(String(params[0]));
      return rows<Row>(row ? [row] : []);
    }
    if (statement.includes("WHERE run_id=$1")) {
      return rows<Row>(this.latestForRun(String(params[0])));
    }
    throw new Error(`Unhandled manifest SQL: ${statement}`);
  }

  async transaction<T>(
    callback: (client: SqlClient) => Promise<T>,
  ): Promise<T> {
    return await callback(this);
  }

  private latestForRun(runId: string): ManifestRow[] {
    const latest = [...this.rowsByWorkspace.values()]
      .filter((row) => row.run_id === runId)
      .sort(compareLatestManifestRows)[0];
    return latest ? [latest] : [];
  }
}

describe("PostgresWorkspaceManifestRepository", () => {
  it("persists canonical manifest fields and reads by workspace", async () => {
    const repository = createRepository();
    const created = await repository.create(manifest());

    await expect(
      repository.getByWorkspaceId(created.workspaceId),
    ).resolves.toEqual(created);
  });

  it("returns the latest manifest by deterministic run ordering", async () => {
    const repository = createRepository();
    await repository.create(manifest({ workspaceId: "wrk_first123" }));
    const latest = await repository.create(
      manifest({ workspaceId: "wrk_second123" }),
    );

    await expect(repository.getLatestByRunId(latest.runId)).resolves.toEqual(
      latest,
    );
  });

  it("returns typed errors for missing updates", async () => {
    await expect(createRepository().update(manifest())).rejects.toMatchObject({
      code: "workspace_manifest_not_found",
    });
  });
});

registerWorkspaceRepositoryConformance(
  "PostgresWorkspaceManifestRepository",
  createRepository,
);

function createRepository(): PostgresWorkspaceManifestRepository {
  return new PostgresWorkspaceManifestRepository(new ManifestSqlClient());
}

function manifest(
  overrides: Partial<WorkspaceManifest> = {},
): WorkspaceManifest {
  return {
    runId: "run_manifest01",
    workspaceId: "wrk_manifest01",
    repoOwner: "owner",
    repoName: "repo",
    repoUrl: "https://example.com/owner/repo",
    baseBranch: "dev",
    workingBranch: "feat/persistence",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    executionLocation: "cloud_sandbox",
    workerId: "worker_manifest01",
    filesystemRoot: "/home/sandbox/runs/run_manifest01",
    artifactNamespace: "runs/run_manifest01/artifacts",
    permissionProfileId: "perm_manifest01",
    state: "ready",
    lastError: null,
    createdAt: "2026-06-22T00:00:00.000Z",
    updatedAt: "2026-06-22T00:00:00.000Z",
    ...overrides,
  };
}

function compareLatestManifestRows(
  left: ManifestRow,
  right: ManifestRow,
): number {
  return (
    right.updated_at.localeCompare(left.updated_at) ||
    right.created_at.localeCompare(left.created_at) ||
    right.workspace_id.localeCompare(left.workspace_id)
  );
}

function createRow(params: readonly SqlValue[]): ManifestRow {
  const value = (index: number): string => String(params[index]);
  return {
    workspace_id: value(0),
    run_id: value(1),
    repo_owner: value(2),
    repo_name: value(3),
    repo_url: value(4),
    base_branch: value(5),
    working_branch: value(6),
    base_sha: value(7),
    head_sha: value(8),
    execution_location: value(9),
    worker_id: value(10),
    filesystem_root: value(11),
    artifact_namespace: value(12),
    permission_profile_id: value(13),
    state: value(14),
    last_error: params[15] === null ? null : value(15),
    created_at: value(16),
    updated_at: value(17),
  };
}

function rows<Row extends SqlRow>(values: SqlRow[]): SqlQueryResult<Row> {
  return { rows: values as Row[], rowCount: values.length };
}
