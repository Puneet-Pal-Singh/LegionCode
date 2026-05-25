import type {
  CreateEditArtifactInput,
  EditArtifactEvent,
  EditArtifactRecord,
} from "@repo/shared-types";
import type { SqlClient } from "../sql.js";
import {
  type ArtifactEventRow,
  type ArtifactRow,
  mapArtifactEventRow,
  mapArtifactRow,
  readReturnedRow,
} from "./artifactMappers.js";
import type {
  AppendArtifactEventInput,
  ArtifactRepository,
  UpdateArtifactStatusInput,
} from "./types.js";

interface Clock {
  now(): Date;
}

const systemClock: Clock = {
  now: () => new Date(),
};

export class PostgresArtifactRepository implements ArtifactRepository {
  constructor(
    private readonly client: SqlClient,
    private readonly clock: Clock = systemClock,
  ) {}

  async createPendingArtifact(
    input: CreateEditArtifactInput,
  ): Promise<EditArtifactRecord> {
    const now = this.clock.now();
    await this.client.transaction(async (tx) => {
      await tx.query<ArtifactRow>(INSERT_ARTIFACT_SQL, [
        input.id,
        input.userId,
        input.workspaceId,
        input.sessionId,
        input.runId,
        input.repoOwner,
        input.repoName,
        input.repoUrl,
        input.branch,
        input.baseCommitSha,
        input.artifactKind,
        input.r2ObjectKey,
        input.expiresAt,
        now,
      ]);
      await replaceChangedFiles(tx, input);
    });

    return await this.getArtifactById(input.id, input.userId);
  }

  async appendEvent(
    input: AppendArtifactEventInput,
  ): Promise<EditArtifactEvent> {
    const result = await this.client.query<ArtifactEventRow>(INSERT_EVENT_SQL, [
      input.id,
      input.artifactId,
      input.runId,
      input.eventType,
      input.message,
      JSON.stringify(input.metadata ?? null),
      input.createdAt ? new Date(input.createdAt) : this.clock.now(),
    ]);
    return mapArtifactEventRow(
      readReturnedRow(result.rows[0], "artifact_events"),
    );
  }

  async updateStatus(
    input: UpdateArtifactStatusInput,
  ): Promise<EditArtifactRecord> {
    const result = await this.client.query(UPDATE_STATUS_SQL, [
      input.artifactId,
      input.userId,
      input.status,
      input.contentType ?? null,
      input.sizeBytes ?? null,
      input.sha256 ?? null,
      input.headCommitSha ?? null,
      this.clock.now(),
    ]);
    if (result.rowCount === 0) {
      throw new Error(`Artifact not found: ${input.artifactId}`);
    }
    return await this.getArtifactById(input.artifactId, input.userId);
  }

  async getLatestRestorableArtifact(
    runId: string,
    userId: string,
  ): Promise<EditArtifactRecord | null> {
    const result = await this.client.query<ArtifactRow>(
      LATEST_RESTORABLE_ARTIFACT_SQL,
      [runId, userId],
    );
    const row = result.rows[0];
    return row ? mapArtifactRow(row) : null;
  }

  async getLatestRestorableArtifactForRun(
    runId: string,
  ): Promise<EditArtifactRecord | null> {
    const result = await this.client.query<ArtifactRow>(
      LATEST_RESTORABLE_ARTIFACT_FOR_RUN_SQL,
      [runId],
    );
    const row = result.rows[0];
    return row ? mapArtifactRow(row) : null;
  }

  async listExpiredArtifacts(now: string): Promise<EditArtifactRecord[]> {
    const result = await this.client.query<ArtifactRow>(LIST_EXPIRED_SQL, [
      now,
    ]);
    return result.rows.map(mapArtifactRow);
  }

  async listStalePendingArtifacts(
    cutoff: string,
  ): Promise<EditArtifactRecord[]> {
    const result = await this.client.query<ArtifactRow>(
      LIST_STALE_PENDING_SQL,
      [cutoff],
    );
    return result.rows.map(mapArtifactRow);
  }

  async transaction<T>(
    callback: (repository: ArtifactRepository) => Promise<T>,
  ): Promise<T> {
    return await this.client.transaction(async (tx) => {
      return await callback(new PostgresArtifactRepository(tx, this.clock));
    });
  }

  private async getArtifactById(
    id: string,
    userId: string,
  ): Promise<EditArtifactRecord> {
    const result = await this.client.query<ArtifactRow>(
      GET_ARTIFACT_BY_ID_SQL,
      [id, userId],
    );
    return mapArtifactRow(readReturnedRow(result.rows[0], "artifacts"));
  }
}

async function replaceChangedFiles(
  client: SqlClient,
  input: CreateEditArtifactInput,
): Promise<void> {
  await client.query(DELETE_CHANGED_FILES_SQL, [input.id]);
  for (const file of input.changedFiles) {
    await client.query(INSERT_CHANGED_FILE_SQL, [
      input.id,
      file.path,
      file.status,
      file.additions ?? null,
      file.deletions ?? null,
      JSON.stringify({ isStaged: file.isStaged ?? null }),
    ]);
  }
}

const ARTIFACT_COLUMNS = `
  a.id,
  a.user_id,
  a.workspace_id,
  a.session_id,
  a.run_id,
  a.repo_owner,
  a.repo_name,
  a.repo_url,
  a.branch,
  a.base_commit_sha,
  a.head_commit_sha,
  a.artifact_kind,
  a.r2_object_key,
  a.content_type,
  a.size_bytes,
  a.sha256,
  a.status,
  COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'path', f.path,
        'status', f.change_type,
        'additions', f.additions,
        'deletions', f.deletions,
        'isStaged', f.metadata_json->'isStaged'
      ) ORDER BY f.path
    ) FILTER (WHERE f.path IS NOT NULL),
    '[]'::jsonb
  ) AS changed_files_json,
  a.created_at,
  a.updated_at,
  a.expires_at
`;

const ARTIFACT_GROUP_BY = `
  a.id,
  a.user_id,
  a.workspace_id,
  a.session_id,
  a.run_id,
  a.repo_owner,
  a.repo_name,
  a.repo_url,
  a.branch,
  a.base_commit_sha,
  a.head_commit_sha,
  a.artifact_kind,
  a.r2_object_key,
  a.content_type,
  a.size_bytes,
  a.sha256,
  a.status,
  a.created_at,
  a.updated_at,
  a.expires_at
`;

const INSERT_ARTIFACT_SQL = `
  INSERT INTO artifacts (
    id,
    user_id,
    workspace_id,
    session_id,
    run_id,
    repo_owner,
    repo_name,
    repo_url,
    branch,
    base_commit_sha,
    artifact_kind,
    r2_object_key,
    status,
    expires_at,
    created_at,
    updated_at
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending', $13, $14, $14)
  ON CONFLICT (id)
  DO UPDATE SET
    r2_object_key = EXCLUDED.r2_object_key,
    expires_at = EXCLUDED.expires_at,
    updated_at = EXCLUDED.updated_at
`;

const INSERT_EVENT_SQL = `
  INSERT INTO artifact_events (
    id,
    artifact_id,
    run_id,
    event_type,
    message,
    metadata_json,
    created_at
  )
  VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
  RETURNING id, artifact_id, run_id, event_type, message, metadata_json, created_at
`;

const UPDATE_STATUS_SQL = `
  UPDATE artifacts
  SET
    status = $3,
    content_type = COALESCE($4, content_type),
    size_bytes = COALESCE($5, size_bytes),
    sha256 = COALESCE($6, sha256),
    head_commit_sha = COALESCE($7, head_commit_sha),
    updated_at = $8
  WHERE id = $1
    AND user_id = $2
`;

const LATEST_RESTORABLE_ARTIFACT_SQL = `
  SELECT ${ARTIFACT_COLUMNS}
  FROM artifacts a
  LEFT JOIN artifact_changed_files f ON f.artifact_id = a.id
  WHERE a.run_id = $1
    AND a.user_id = $2
    AND a.status IN ('stored', 'restored', 'restore_failed', 'restore_in_progress')
    AND EXISTS (
      SELECT 1
      FROM artifact_changed_files cf
      WHERE cf.artifact_id = a.id
    )
  GROUP BY ${ARTIFACT_GROUP_BY}
  ORDER BY a.updated_at DESC
  LIMIT 1
`;

const LATEST_RESTORABLE_ARTIFACT_FOR_RUN_SQL = `
  SELECT ${ARTIFACT_COLUMNS}
  FROM artifacts a
  LEFT JOIN artifact_changed_files f ON f.artifact_id = a.id
  WHERE a.run_id = $1
    AND a.status IN ('stored', 'restored', 'restore_failed', 'restore_in_progress')
    AND EXISTS (
      SELECT 1
      FROM artifact_changed_files cf
      WHERE cf.artifact_id = a.id
    )
  GROUP BY ${ARTIFACT_GROUP_BY}
  ORDER BY a.updated_at DESC
  LIMIT 1
`;

const LIST_EXPIRED_SQL = `
  SELECT ${ARTIFACT_COLUMNS}
  FROM artifacts a
  LEFT JOIN artifact_changed_files f ON f.artifact_id = a.id
  WHERE a.status = 'stored' AND a.expires_at <= $1
  GROUP BY ${ARTIFACT_GROUP_BY}
  ORDER BY a.updated_at ASC
`;

const LIST_STALE_PENDING_SQL = `
  SELECT ${ARTIFACT_COLUMNS}
  FROM artifacts a
  LEFT JOIN artifact_changed_files f ON f.artifact_id = a.id
  WHERE a.status = 'pending' AND a.created_at <= $1
  GROUP BY ${ARTIFACT_GROUP_BY}
  ORDER BY a.created_at ASC
`;

const GET_ARTIFACT_BY_ID_SQL = `
  SELECT ${ARTIFACT_COLUMNS}
  FROM artifacts a
  LEFT JOIN artifact_changed_files f ON f.artifact_id = a.id
  WHERE a.id = $1
    AND a.user_id = $2
  GROUP BY ${ARTIFACT_GROUP_BY}
`;

const DELETE_CHANGED_FILES_SQL = `
  DELETE FROM artifact_changed_files WHERE artifact_id = $1
`;

const INSERT_CHANGED_FILE_SQL = `
  INSERT INTO artifact_changed_files (
    artifact_id,
    path,
    change_type,
    additions,
    deletions,
    metadata_json
  )
  VALUES ($1, $2, $3, $4, $5, $6::jsonb)
`;
