import type { WorkspaceManifest } from "@repo/platform-protocol";
import { describe, expect, it } from "vitest";
import type { SqlClient, SqlQueryResult, SqlRow, SqlValue } from "../sql.js";
import { PostgresWorkspaceManifestRepository } from "./PostgresWorkspaceManifestRepository.js";
import { WorkspaceManifestError } from "./types.js";

interface ManifestRow extends SqlRow {
  manifest_id: string;
  workspace_id: string;
  run_id: string;
  user_id: string;
  worker_id: string;
  permission_profile_id: string;
  repo_owner: string;
  repo_name: string;
  repo_url: string;
  base_branch: string;
  working_branch: string;
  base_commit_sha: string;
  head_commit_sha: string;
  execution_location: string;
  filesystem_root: string;
  artifact_namespace: string;
  state: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

class ManifestSqlClient implements SqlClient {
  private readonly rows = new Map<string, ManifestRow>();

  async query<Row extends SqlRow = SqlRow>(
    statement: string,
    params: readonly SqlValue[] = [],
  ): Promise<SqlQueryResult<Row>> {
    if (statement.includes("INSERT INTO workspace_manifests")) {
      const row = createManifestRow(params);
      this.rows.set(row.manifest_id, row);
      return rowsResult<Row>([row]);
    }
    if (statement.includes("UPDATE workspace_manifests")) {
      return rowsResult<Row>([this.updateManifest(params)]);
    }
    if (statement.includes("WHERE manifest_id = $1")) {
      const row = this.rows.get(readStringParam(params[0], "manifest_id"));
      return rowsResult<Row>(row ? [row] : []);
    }
    if (statement.includes("WHERE run_id = $1")) {
      return rowsResult<Row>(this.selectLatestForRun(params));
    }
    throw new Error(`Unhandled SQL: ${statement}`);
  }

  async transaction<T>(callback: (client: SqlClient) => Promise<T>): Promise<T> {
    return await callback(this);
  }

  private updateManifest(params: readonly SqlValue[]): ManifestRow {
    const manifestId = readStringParam(params[0], "manifest_id");
    const current = this.rows.get(manifestId);
    if (!current) {
      throw new Error(`Missing manifest: ${manifestId}`);
    }
    const row = {
      ...current,
      head_commit_sha: readStringParam(params[1], "head_commit_sha"),
      state: readStringParam(params[2], "state"),
      last_error: readNullableStringParam(params[3], "last_error"),
      updated_at: readStringParam(params[4], "updated_at"),
    };
    this.rows.set(row.manifest_id, row);
    return row;
  }

  private selectLatestForRun(params: readonly SqlValue[]): ManifestRow[] {
    const runId = readStringParam(params[0], "run_id");
    const row = [...this.rows.values()]
      .filter((candidate) => candidate.run_id === runId)
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0];
    return row ? [row] : [];
  }
}

describe("PostgresWorkspaceManifestRepository", () => {
  it("persists, transitions, and reads latest manifests", async () => {
    const repository = new PostgresWorkspaceManifestRepository(
      new ManifestSqlClient(),
    );

    await repository.saveManifest({ manifest });
    await repository.transitionManifest({
      manifestId: "wsm_abc123",
      nextState: "ready",
      headCommitSha: "c".repeat(40),
      lastError: null,
      updatedAt: "2026-06-09T13:00:00.000Z",
    });
    const latest = await repository.getLatestManifestForRun("run_abc123");

    expect(latest?.state).toBe("ready");
    expect(latest?.headCommitSha).toBe("c".repeat(40));
  });

  it("rejects immutable identity changes on repeated save", async () => {
    const repository = new PostgresWorkspaceManifestRepository(
      new ManifestSqlClient(),
    );

    await repository.saveManifest({ manifest });

    await expect(
      repository.saveManifest({
        manifest: {
          ...manifest,
          workingBranch: "feat/other",
        },
      }),
    ).rejects.toThrow(WorkspaceManifestError);
  });
});

const manifest: WorkspaceManifest = {
  manifestId: "wsm_abc123",
  workspaceId: "wrk_abc123",
  runId: "run_abc123",
  userId: "usr_abc123",
  workerId: "worker_abc123",
  permissionProfileId: "perm_abc123",
  repoOwner: "Puneet-Pal-Singh",
  repoName: "LegionCode",
  repoUrl: "https://github.com/Puneet-Pal-Singh/LegionCode",
  baseBranch: "dev",
  workingBranch: "feat/workspace-artifact-persistence",
  baseCommitSha: "a".repeat(40),
  headCommitSha: "b".repeat(40),
  executionLocation: "cloud_sandbox",
  filesystemRoot: "/home/sandbox/runs/run_abc123",
  artifactNamespace: "runs/run_abc123/artifacts",
  state: "preparing",
  lastError: null,
  createdAt: "2026-06-09T12:00:00.000Z",
  updatedAt: "2026-06-09T12:00:00.000Z",
};

function createManifestRow(params: readonly SqlValue[]): ManifestRow {
  return {
    manifest_id: readStringParam(params[0], "manifest_id"),
    workspace_id: readStringParam(params[1], "workspace_id"),
    run_id: readStringParam(params[2], "run_id"),
    user_id: readStringParam(params[3], "user_id"),
    worker_id: readStringParam(params[4], "worker_id"),
    permission_profile_id: readStringParam(params[5], "permission_profile_id"),
    repo_owner: readStringParam(params[6], "repo_owner"),
    repo_name: readStringParam(params[7], "repo_name"),
    repo_url: readStringParam(params[8], "repo_url"),
    base_branch: readStringParam(params[9], "base_branch"),
    working_branch: readStringParam(params[10], "working_branch"),
    base_commit_sha: readStringParam(params[11], "base_commit_sha"),
    head_commit_sha: readStringParam(params[12], "head_commit_sha"),
    execution_location: readStringParam(params[13], "execution_location"),
    filesystem_root: readStringParam(params[14], "filesystem_root"),
    artifact_namespace: readStringParam(params[15], "artifact_namespace"),
    state: readStringParam(params[16], "state"),
    last_error: readNullableStringParam(params[17], "last_error"),
    created_at: readStringParam(params[18], "created_at"),
    updated_at: readStringParam(params[19], "updated_at"),
  };
}

function rowsResult<Row extends SqlRow>(rows: readonly SqlRow[]): SqlQueryResult<Row> {
  return { rows: rows as Row[], rowCount: rows.length };
}

function readStringParam(value: SqlValue | undefined, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected string param: ${name}`);
  }
  return value;
}

function readNullableStringParam(
  value: SqlValue | undefined,
  name: string,
): string | null {
  if (value === null) {
    return null;
  }
  return readStringParam(value, name);
}
