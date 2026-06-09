import {
  RunIdSchema,
  WorkspaceManifestIdSchema,
  WorkspaceManifestSchema,
  type RunId,
  type WorkspaceManifest,
  type WorkspaceManifestId,
} from "@repo/platform-protocol";
import type { SqlClient, SqlRow, SqlValue } from "../sql.js";
import {
  WorkspaceManifestError,
  assertWorkspaceManifestIdentityUnchanged,
  transitionWorkspaceManifestState,
  type SaveWorkspaceManifestInput,
  type TransitionWorkspaceManifestInput,
  type WorkspaceManifestRepository,
} from "./types.js";

interface WorkspaceManifestRow extends SqlRow {
  manifest_id?: string;
  workspace_id?: string;
  run_id?: string;
  user_id?: string;
  worker_id?: string;
  permission_profile_id?: string;
  repo_owner?: string;
  repo_name?: string;
  repo_url?: string;
  base_branch?: string;
  working_branch?: string;
  base_commit_sha?: string;
  head_commit_sha?: string;
  execution_location?: string;
  filesystem_root?: string;
  artifact_namespace?: string;
  state?: string;
  last_error?: string | null;
  created_at?: string | Date;
  updated_at?: string | Date;
}

export class PostgresWorkspaceManifestRepository
  implements WorkspaceManifestRepository
{
  constructor(private readonly client: SqlClient) {}

  async saveManifest(
    input: SaveWorkspaceManifestInput,
  ): Promise<WorkspaceManifest> {
    const manifest = WorkspaceManifestSchema.parse(input.manifest);
    return await this.client.transaction(async (tx) => {
      const existing = await readManifest(tx, manifest.manifestId);
      if (existing) {
        assertWorkspaceManifestIdentityUnchanged(existing, manifest);
        return await updateManifest(tx, manifest);
      }
      return await insertManifest(tx, manifest);
    });
  }

  async transitionManifest(
    input: TransitionWorkspaceManifestInput,
  ): Promise<WorkspaceManifest> {
    const manifestId = WorkspaceManifestIdSchema.parse(input.manifestId);
    return await this.client.transaction(async (tx) => {
      const current = await readManifest(tx, manifestId);
      if (!current) {
        throw new WorkspaceManifestError(
          "manifest_not_found",
          `Workspace manifest not found: ${manifestId}`,
        );
      }
      const next = WorkspaceManifestSchema.parse({
        ...current,
        state: transitionWorkspaceManifestState(
          current.state,
          input.nextState,
        ),
        headCommitSha: input.headCommitSha,
        lastError: input.lastError,
        updatedAt: input.updatedAt,
      });
      return await updateManifest(tx, next);
    });
  }

  async getManifest(
    manifestId: WorkspaceManifestId,
  ): Promise<WorkspaceManifest | null> {
    return await readManifest(
      this.client,
      WorkspaceManifestIdSchema.parse(manifestId),
    );
  }

  async getLatestManifestForRun(
    runId: RunId,
  ): Promise<WorkspaceManifest | null> {
    const result = await this.client.query<WorkspaceManifestRow>(
      SELECT_LATEST_MANIFEST_FOR_RUN_SQL,
      [RunIdSchema.parse(runId)],
    );
    return mapOptionalManifest(result.rows[0]);
  }
}

async function readManifest(
  client: SqlClient,
  manifestId: WorkspaceManifestId,
): Promise<WorkspaceManifest | null> {
  const result = await client.query<WorkspaceManifestRow>(
    SELECT_MANIFEST_SQL,
    [manifestId],
  );
  return mapOptionalManifest(result.rows[0]);
}

async function insertManifest(
  client: SqlClient,
  manifest: WorkspaceManifest,
): Promise<WorkspaceManifest> {
  const result = await client.query<WorkspaceManifestRow>(
    INSERT_MANIFEST_SQL,
    manifestParams(manifest),
  );
  return mapRequiredManifest(result.rows[0], "insert");
}

async function updateManifest(
  client: SqlClient,
  manifest: WorkspaceManifest,
): Promise<WorkspaceManifest> {
  const result = await client.query<WorkspaceManifestRow>(
    UPDATE_MANIFEST_SQL,
    [
      manifest.manifestId,
      manifest.headCommitSha,
      manifest.state,
      manifest.lastError,
      manifest.updatedAt,
    ],
  );
  return mapRequiredManifest(result.rows[0], "update");
}

function manifestParams(manifest: WorkspaceManifest): readonly SqlValue[] {
  return [
    manifest.manifestId,
    manifest.workspaceId,
    manifest.runId,
    manifest.userId,
    manifest.workerId,
    manifest.permissionProfileId,
    manifest.repoOwner,
    manifest.repoName,
    manifest.repoUrl,
    manifest.baseBranch,
    manifest.workingBranch,
    manifest.baseCommitSha,
    manifest.headCommitSha,
    manifest.executionLocation,
    manifest.filesystemRoot,
    manifest.artifactNamespace,
    manifest.state,
    manifest.lastError,
    manifest.createdAt,
    manifest.updatedAt,
  ];
}

function mapRequiredManifest(
  row: WorkspaceManifestRow | undefined,
  operation: string,
): WorkspaceManifest {
  const manifest = mapOptionalManifest(row);
  if (!manifest) {
    throw new Error(`Workspace manifest ${operation} returned no row`);
  }
  return manifest;
}

function mapOptionalManifest(
  row: WorkspaceManifestRow | undefined,
): WorkspaceManifest | null {
  if (!row) {
    return null;
  }
  return WorkspaceManifestSchema.parse({
    manifestId: requireString(row.manifest_id, "manifest_id"),
    workspaceId: requireString(row.workspace_id, "workspace_id"),
    runId: requireString(row.run_id, "run_id"),
    userId: requireString(row.user_id, "user_id"),
    workerId: requireString(row.worker_id, "worker_id"),
    permissionProfileId: requireString(
      row.permission_profile_id,
      "permission_profile_id",
    ),
    repoOwner: requireString(row.repo_owner, "repo_owner"),
    repoName: requireString(row.repo_name, "repo_name"),
    repoUrl: requireString(row.repo_url, "repo_url"),
    baseBranch: requireString(row.base_branch, "base_branch"),
    workingBranch: requireString(row.working_branch, "working_branch"),
    baseCommitSha: requireString(row.base_commit_sha, "base_commit_sha"),
    headCommitSha: requireString(row.head_commit_sha, "head_commit_sha"),
    executionLocation: requireString(
      row.execution_location,
      "execution_location",
    ),
    filesystemRoot: requireString(row.filesystem_root, "filesystem_root"),
    artifactNamespace: requireString(
      row.artifact_namespace,
      "artifact_namespace",
    ),
    state: requireString(row.state, "state"),
    lastError: row.last_error ?? null,
    createdAt: toIsoString(row.created_at, "created_at"),
    updatedAt: toIsoString(row.updated_at, "updated_at"),
  });
}

function requireString(value: unknown, column: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected non-empty string column: ${column}`);
  }
  return value;
}

function toIsoString(value: unknown, column: string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return requireString(value, column);
}

const MANIFEST_COLUMNS = `
  manifest_id,
  workspace_id,
  run_id,
  user_id,
  worker_id,
  permission_profile_id,
  repo_owner,
  repo_name,
  repo_url,
  base_branch,
  working_branch,
  base_commit_sha,
  head_commit_sha,
  execution_location,
  filesystem_root,
  artifact_namespace,
  state,
  last_error,
  created_at,
  updated_at
`;

const SELECT_MANIFEST_SQL = `
  SELECT ${MANIFEST_COLUMNS}
  FROM workspace_manifests
  WHERE manifest_id = $1
`;

const SELECT_LATEST_MANIFEST_FOR_RUN_SQL = `
  SELECT ${MANIFEST_COLUMNS}
  FROM workspace_manifests
  WHERE run_id = $1
  ORDER BY updated_at DESC, created_at DESC
  LIMIT 1
`;

const INSERT_MANIFEST_SQL = `
  INSERT INTO workspace_manifests (
    manifest_id,
    workspace_id,
    run_id,
    user_id,
    worker_id,
    permission_profile_id,
    repo_owner,
    repo_name,
    repo_url,
    base_branch,
    working_branch,
    base_commit_sha,
    head_commit_sha,
    execution_location,
    filesystem_root,
    artifact_namespace,
    state,
    last_error,
    created_at,
    updated_at
  )
  VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
    $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
  )
  RETURNING ${MANIFEST_COLUMNS}
`;

const UPDATE_MANIFEST_SQL = `
  UPDATE workspace_manifests
  SET
    head_commit_sha = $2,
    state = $3,
    last_error = $4,
    updated_at = $5
  WHERE manifest_id = $1
  RETURNING ${MANIFEST_COLUMNS}
`;
