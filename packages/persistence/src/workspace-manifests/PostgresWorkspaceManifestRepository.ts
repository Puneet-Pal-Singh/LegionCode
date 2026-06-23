import type { RunId, WorkspaceId } from "@repo/platform-protocol";
import {
  createManifestAlreadyExistsError,
  createManifestNotFoundError,
  parseWorkspaceManifest,
  validateWorkspaceManifestUpdate,
  type WorkspaceManifest,
  type WorkspaceManifestRepository,
  type WorkspaceTransitionOptions,
} from "@repo/workspace-core";
import type { SqlClient, SqlRow, SqlValue } from "../sql.js";

const POSTGRES_UNIQUE_VIOLATION = "23505";

interface WorkspaceManifestRow extends SqlRow {
  workspace_id?: string;
  run_id?: string;
  repo_owner?: string;
  repo_name?: string;
  repo_url?: string;
  base_branch?: string;
  working_branch?: string;
  base_sha?: string;
  head_sha?: string;
  execution_location?: string;
  worker_id?: string;
  filesystem_root?: string;
  artifact_namespace?: string;
  permission_profile_id?: string;
  state?: string;
  last_error?: string | null;
  created_at?: string | Date;
  updated_at?: string | Date;
}

export class PostgresWorkspaceManifestRepository implements WorkspaceManifestRepository {
  constructor(private readonly client: SqlClient) {}

  async create(manifest: WorkspaceManifest): Promise<WorkspaceManifest> {
    const parsed = parseWorkspaceManifest(manifest);
    try {
      return await writeManifest(this.client, INSERT_MANIFEST_SQL, parsed);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw createManifestAlreadyExistsError(parsed.workspaceId);
      }
      throw error;
    }
  }

  async update(
    manifest: WorkspaceManifest,
    options: WorkspaceTransitionOptions = {},
  ): Promise<WorkspaceManifest> {
    const parsed = parseWorkspaceManifest(manifest);
    return await this.client.transaction(async (tx) => {
      const current = await readManifest(tx, parsed.workspaceId, true);
      if (!current) {
        throw createManifestNotFoundError(parsed.workspaceId);
      }
      const next = validateWorkspaceManifestUpdate(current, parsed, options);
      return await writeManifest(tx, UPDATE_MANIFEST_SQL, next);
    });
  }

  async getByWorkspaceId(
    workspaceId: WorkspaceId,
  ): Promise<WorkspaceManifest | null> {
    return await readManifest(this.client, workspaceId, false);
  }

  async getLatestByRunId(runId: RunId): Promise<WorkspaceManifest | null> {
    const result = await this.client.query<WorkspaceManifestRow>(
      SELECT_LATEST_BY_RUN_SQL,
      [runId],
    );
    return mapOptionalManifest(result.rows[0]);
  }
}

async function readManifest(
  client: SqlClient,
  workspaceId: WorkspaceId,
  lock: boolean,
): Promise<WorkspaceManifest | null> {
  const sql = lock ? SELECT_MANIFEST_FOR_UPDATE_SQL : SELECT_MANIFEST_SQL;
  const result = await client.query<WorkspaceManifestRow>(sql, [workspaceId]);
  return mapOptionalManifest(result.rows[0]);
}

async function writeManifest(
  client: SqlClient,
  statement: string,
  manifest: WorkspaceManifest,
): Promise<WorkspaceManifest> {
  const result = await client.query<WorkspaceManifestRow>(
    statement,
    manifestParams(manifest),
  );
  const persisted = mapOptionalManifest(result.rows[0]);
  if (!persisted) {
    throw new Error(
      `Workspace manifest write returned no row: ${manifest.workspaceId}`,
    );
  }
  return persisted;
}

function manifestParams(manifest: WorkspaceManifest): readonly SqlValue[] {
  return [
    manifest.workspaceId,
    manifest.runId,
    manifest.repoOwner,
    manifest.repoName,
    manifest.repoUrl,
    manifest.baseBranch,
    manifest.workingBranch,
    manifest.baseSha,
    manifest.headSha,
    manifest.executionLocation,
    manifest.workerId,
    manifest.filesystemRoot,
    manifest.artifactNamespace,
    manifest.permissionProfileId,
    manifest.state,
    manifest.lastError,
    manifest.createdAt,
    manifest.updatedAt,
  ];
}

function mapOptionalManifest(
  row: WorkspaceManifestRow | undefined,
): WorkspaceManifest | null {
  if (!row) return null;
  return parseWorkspaceManifest({
    workspaceId: requireString(row.workspace_id, "workspace_id"),
    runId: requireString(row.run_id, "run_id"),
    repoOwner: requireString(row.repo_owner, "repo_owner"),
    repoName: requireString(row.repo_name, "repo_name"),
    repoUrl: requireString(row.repo_url, "repo_url"),
    baseBranch: requireString(row.base_branch, "base_branch"),
    workingBranch: requireString(row.working_branch, "working_branch"),
    baseSha: requireString(row.base_sha, "base_sha"),
    headSha: requireString(row.head_sha, "head_sha"),
    executionLocation: requireString(
      row.execution_location,
      "execution_location",
    ),
    workerId: requireString(row.worker_id, "worker_id"),
    filesystemRoot: requireString(row.filesystem_root, "filesystem_root"),
    artifactNamespace: requireString(
      row.artifact_namespace,
      "artifact_namespace",
    ),
    permissionProfileId: requireString(
      row.permission_profile_id,
      "permission_profile_id",
    ),
    state: requireString(row.state, "state"),
    lastError: row.last_error ?? null,
    createdAt: toIsoString(row.created_at, "created_at"),
    updatedAt: toIsoString(row.updated_at, "updated_at"),
  });
}

function requireString(value: unknown, column: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected non-empty workspace manifest column: ${column}`);
  }
  return value;
}

function toIsoString(value: unknown, column: string): string {
  return value instanceof Date
    ? value.toISOString()
    : requireString(value, column);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === POSTGRES_UNIQUE_VIOLATION
  );
}

const MANIFEST_COLUMNS = `workspace_id, run_id, repo_owner, repo_name, repo_url,
  base_branch, working_branch, base_sha, head_sha, execution_location, worker_id,
  filesystem_root, artifact_namespace, permission_profile_id, state, last_error,
  created_at, updated_at`;

const INSERT_MANIFEST_SQL = `INSERT INTO workspace_manifests (${MANIFEST_COLUMNS})
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
  RETURNING ${MANIFEST_COLUMNS}`;
const UPDATE_MANIFEST_SQL = `UPDATE workspace_manifests SET head_sha=$9, state=$15,
  last_error=$16, updated_at=$18 WHERE workspace_id=$1 RETURNING ${MANIFEST_COLUMNS}`;
const SELECT_MANIFEST_SQL = `SELECT ${MANIFEST_COLUMNS} FROM workspace_manifests WHERE workspace_id=$1`;
const SELECT_MANIFEST_FOR_UPDATE_SQL = `${SELECT_MANIFEST_SQL} FOR UPDATE`;
const SELECT_LATEST_BY_RUN_SQL = `SELECT ${MANIFEST_COLUMNS} FROM workspace_manifests
  WHERE run_id=$1 ORDER BY updated_at DESC, created_at DESC, workspace_id DESC LIMIT 1`;
