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
  UpdateArtifactReviewMetadataInput,
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
        input.userMessageId ?? null,
        input.assistantMessageId ?? null,
        input.sourceTurnId ?? null,
        input.captureSequence ?? 0,
        input.patchParseStatus ?? "unknown",
        input.patchSha256 ?? null,
        input.storageBackend ?? "r2_postgres",
        input.cfArtifactRepo ?? null,
        input.cfArtifactCommitSha ?? null,
        input.cfArtifactPath ?? null,
        input.storageReconciliationStatus ?? null,
        input.expiresAt,
        now,
      ]);
      await replaceChangedFiles(tx, input);
    });

    return await this.requireArtifactById(input.id, input.userId);
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
    return await this.requireArtifactById(input.artifactId, input.userId);
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

  async listRestorableArtifacts(input: {
    runId: string;
    userId?: string;
  }): Promise<EditArtifactRecord[]> {
    const result = input.userId
      ? await this.client.query<ArtifactRow>(LIST_RESTORABLE_ARTIFACTS_SQL, [
          input.runId,
          input.userId,
        ])
      : await this.client.query<ArtifactRow>(
          LIST_RESTORABLE_ARTIFACTS_FOR_RUN_SQL,
          [input.runId],
        );
    return result.rows.map(mapArtifactRow);
  }

  async getArtifactById(
    artifactId: string,
    userId: string,
  ): Promise<EditArtifactRecord | null> {
    const result = await this.client.query<ArtifactRow>(
      GET_ARTIFACT_BY_ID_SQL,
      [artifactId, userId],
    );
    const row = result.rows[0];
    return row ? mapArtifactRow(row) : null;
  }

  async getArtifactByIdForRun(
    artifactId: string,
    runId: string,
  ): Promise<EditArtifactRecord | null> {
    const result = await this.client.query<ArtifactRow>(
      GET_ARTIFACT_BY_ID_FOR_RUN_SQL,
      [artifactId, runId],
    );
    const row = result.rows[0];
    return row ? mapArtifactRow(row) : null;
  }

  async getLatestReviewArtifact(input: {
    runId: string;
    userId: string;
    sessionId?: string;
  }): Promise<EditArtifactRecord | null> {
    const result = await this.client.query<ArtifactRow>(
      LATEST_REVIEW_ARTIFACT_SQL,
      [input.runId, input.userId, input.sessionId ?? null],
    );
    const row = result.rows[0];
    return row ? mapArtifactRow(row) : null;
  }

  async getLatestReviewArtifactForRun(input: {
    runId: string;
    sessionId?: string;
  }): Promise<EditArtifactRecord | null> {
    const result = await this.client.query<ArtifactRow>(
      LATEST_REVIEW_ARTIFACT_FOR_RUN_SQL,
      [input.runId, input.sessionId ?? null],
    );
    const row = result.rows[0];
    return row ? mapArtifactRow(row) : null;
  }

  async getReviewArtifactByMessage(input: {
    runId: string;
    userId: string;
    assistantMessageId: string;
  }): Promise<EditArtifactRecord | null> {
    const result = await this.client.query<ArtifactRow>(
      REVIEW_ARTIFACT_BY_MESSAGE_SQL,
      [input.runId, input.userId, input.assistantMessageId],
    );
    const row = result.rows[0];
    return row ? mapArtifactRow(row) : null;
  }

  async getReviewArtifactByMessageForRun(input: {
    runId: string;
    assistantMessageId: string;
  }): Promise<EditArtifactRecord | null> {
    const result = await this.client.query<ArtifactRow>(
      REVIEW_ARTIFACT_BY_MESSAGE_FOR_RUN_SQL,
      [input.runId, input.assistantMessageId],
    );
    const row = result.rows[0];
    return row ? mapArtifactRow(row) : null;
  }

  async updateReviewMetadata(
    input: UpdateArtifactReviewMetadataInput,
  ): Promise<EditArtifactRecord> {
    const result = await this.client.query(UPDATE_REVIEW_METADATA_SQL, [
      input.artifactId,
      input.userId,
      hasOwn(input, "userMessageId"),
      input.userMessageId ?? null,
      hasOwn(input, "assistantMessageId"),
      input.assistantMessageId ?? null,
      hasOwn(input, "sourceTurnId"),
      input.sourceTurnId ?? null,
      hasOwn(input, "captureSequence"),
      input.captureSequence ?? null,
      hasOwn(input, "patchParseStatus"),
      input.patchParseStatus ?? null,
      hasOwn(input, "patchSha256"),
      input.patchSha256 ?? null,
      hasOwn(input, "storageBackend"),
      input.storageBackend ?? null,
      hasOwn(input, "cfArtifactRepo"),
      input.cfArtifactRepo ?? null,
      hasOwn(input, "cfArtifactCommitSha"),
      input.cfArtifactCommitSha ?? null,
      hasOwn(input, "cfArtifactPath"),
      input.cfArtifactPath ?? null,
      hasOwn(input, "storageReconciliationStatus"),
      input.storageReconciliationStatus ?? null,
      this.clock.now(),
    ]);
    if (result.rowCount === 0) {
      throw new Error(`Artifact not found: ${input.artifactId}`);
    }
    return await this.requireArtifactById(input.artifactId, input.userId);
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

  private async requireArtifactById(
    id: string,
    userId: string,
  ): Promise<EditArtifactRecord> {
    const artifact = await this.getArtifactById(id, userId);
    if (!artifact) {
      throw new Error(`Artifact not found: ${id}`);
    }
    return artifact;
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
  a.user_message_id,
  a.assistant_message_id,
  a.source_turn_id,
  a.capture_sequence,
  a.patch_parse_status,
  a.patch_sha256,
  a.storage_backend,
  a.cf_artifact_repo,
  a.cf_artifact_commit_sha,
  a.cf_artifact_path,
  a.storage_reconciliation_status,
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
  a.user_message_id,
  a.assistant_message_id,
  a.source_turn_id,
  a.capture_sequence,
  a.patch_parse_status,
  a.patch_sha256,
  a.storage_backend,
  a.cf_artifact_repo,
  a.cf_artifact_commit_sha,
  a.cf_artifact_path,
  a.storage_reconciliation_status,
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
    user_message_id,
    assistant_message_id,
    source_turn_id,
    capture_sequence,
    patch_parse_status,
    patch_sha256,
    storage_backend,
    cf_artifact_repo,
    cf_artifact_commit_sha,
    cf_artifact_path,
    storage_reconciliation_status,
    status,
    expires_at,
    created_at,
    updated_at
  )
  VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
    $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
    $21, $22, $23, 'pending', $24, $25, $25
  )
  ON CONFLICT (id)
  DO UPDATE SET
    r2_object_key = EXCLUDED.r2_object_key,
    user_message_id = EXCLUDED.user_message_id,
    assistant_message_id = EXCLUDED.assistant_message_id,
    source_turn_id = EXCLUDED.source_turn_id,
    capture_sequence = EXCLUDED.capture_sequence,
    patch_parse_status = EXCLUDED.patch_parse_status,
    patch_sha256 = EXCLUDED.patch_sha256,
    storage_backend = EXCLUDED.storage_backend,
    cf_artifact_repo = EXCLUDED.cf_artifact_repo,
    cf_artifact_commit_sha = EXCLUDED.cf_artifact_commit_sha,
    cf_artifact_path = EXCLUDED.cf_artifact_path,
    storage_reconciliation_status = EXCLUDED.storage_reconciliation_status,
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

const RESTORABLE_ARTIFACT_STATUS_SQL = `
  'stored',
  'stored_with_secondary',
  'secondary_write_failed',
  'restored',
  'restore_failed',
  'restore_in_progress',
  'requires_user_resolution'
`;

const LATEST_RESTORABLE_ARTIFACT_SQL = `
  SELECT ${ARTIFACT_COLUMNS}
  FROM artifacts a
  LEFT JOIN artifact_changed_files f ON f.artifact_id = a.id
  WHERE a.run_id = $1
    AND a.user_id = $2
    AND a.status IN (${RESTORABLE_ARTIFACT_STATUS_SQL})
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
    AND a.status IN (${RESTORABLE_ARTIFACT_STATUS_SQL})
    AND EXISTS (
      SELECT 1
      FROM artifact_changed_files cf
      WHERE cf.artifact_id = a.id
    )
  GROUP BY ${ARTIFACT_GROUP_BY}
  ORDER BY a.updated_at DESC
  LIMIT 1
`;

const LIST_RESTORABLE_ARTIFACTS_SQL = `
  SELECT ${ARTIFACT_COLUMNS}
  FROM artifacts a
  LEFT JOIN artifact_changed_files f ON f.artifact_id = a.id
  WHERE a.run_id = $1
    AND a.user_id = $2
    AND a.status IN (${RESTORABLE_ARTIFACT_STATUS_SQL})
    AND EXISTS (
      SELECT 1 FROM artifact_changed_files cf WHERE cf.artifact_id = a.id
    )
  GROUP BY ${ARTIFACT_GROUP_BY}
  ORDER BY a.created_at ASC, a.capture_sequence ASC, a.id ASC
`;

const LIST_RESTORABLE_ARTIFACTS_FOR_RUN_SQL = `
  SELECT ${ARTIFACT_COLUMNS}
  FROM artifacts a
  LEFT JOIN artifact_changed_files f ON f.artifact_id = a.id
  WHERE a.run_id = $1
    AND a.status IN (${RESTORABLE_ARTIFACT_STATUS_SQL})
    AND EXISTS (
      SELECT 1 FROM artifact_changed_files cf WHERE cf.artifact_id = a.id
    )
  GROUP BY ${ARTIFACT_GROUP_BY}
  ORDER BY a.created_at ASC, a.capture_sequence ASC, a.id ASC
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

const GET_ARTIFACT_BY_ID_FOR_RUN_SQL = `
  SELECT ${ARTIFACT_COLUMNS}
  FROM artifacts a
  LEFT JOIN artifact_changed_files f ON f.artifact_id = a.id
  WHERE a.id = $1
    AND a.run_id = $2
  GROUP BY ${ARTIFACT_GROUP_BY}
`;

const LATEST_REVIEW_ARTIFACT_SQL = `
  SELECT ${ARTIFACT_COLUMNS}
  FROM artifacts a
  LEFT JOIN artifact_changed_files f ON f.artifact_id = a.id
  WHERE a.run_id = $1
    AND a.user_id = $2
    AND ($3::uuid IS NULL OR a.session_id = $3::uuid)
    AND a.status IN ('stored', 'stored_with_secondary', 'secondary_write_failed', 'restored', 'requires_user_resolution')
    AND EXISTS (
      SELECT 1
      FROM artifact_changed_files cf
      WHERE cf.artifact_id = a.id
    )
  GROUP BY ${ARTIFACT_GROUP_BY}
  ORDER BY a.capture_sequence DESC, a.created_at DESC
  LIMIT 1
`;

const LATEST_REVIEW_ARTIFACT_FOR_RUN_SQL = `
  SELECT ${ARTIFACT_COLUMNS}
  FROM artifacts a
  LEFT JOIN artifact_changed_files f ON f.artifact_id = a.id
  WHERE a.run_id = $1
    AND ($2::uuid IS NULL OR a.session_id = $2::uuid)
    AND a.status IN ('stored', 'stored_with_secondary', 'secondary_write_failed', 'restored', 'requires_user_resolution')
    AND EXISTS (
      SELECT 1
      FROM artifact_changed_files cf
      WHERE cf.artifact_id = a.id
    )
  GROUP BY ${ARTIFACT_GROUP_BY}
  ORDER BY a.capture_sequence DESC, a.created_at DESC
  LIMIT 1
`;

const REVIEW_ARTIFACT_BY_MESSAGE_SQL = `
  SELECT ${ARTIFACT_COLUMNS}
  FROM artifacts a
  LEFT JOIN artifact_changed_files f ON f.artifact_id = a.id
  WHERE a.run_id = $1
    AND a.user_id = $2
    AND a.assistant_message_id = $3
    AND a.status IN ('stored', 'stored_with_secondary', 'secondary_write_failed', 'restored', 'requires_user_resolution')
  GROUP BY ${ARTIFACT_GROUP_BY}
  ORDER BY a.capture_sequence DESC, a.created_at DESC
  LIMIT 1
`;

const REVIEW_ARTIFACT_BY_MESSAGE_FOR_RUN_SQL = `
  SELECT ${ARTIFACT_COLUMNS}
  FROM artifacts a
  LEFT JOIN artifact_changed_files f ON f.artifact_id = a.id
  WHERE a.run_id = $1
    AND a.assistant_message_id = $2
    AND a.status IN ('stored', 'stored_with_secondary', 'secondary_write_failed', 'restored', 'requires_user_resolution')
  GROUP BY ${ARTIFACT_GROUP_BY}
  ORDER BY a.capture_sequence DESC, a.created_at DESC
  LIMIT 1
`;

const UPDATE_REVIEW_METADATA_SQL = `
  UPDATE artifacts
  SET
    user_message_id = CASE WHEN $3::boolean THEN $4::text ELSE user_message_id END,
    assistant_message_id = CASE WHEN $5::boolean THEN $6::text ELSE assistant_message_id END,
    source_turn_id = CASE WHEN $7::boolean THEN $8::text ELSE source_turn_id END,
    capture_sequence = CASE WHEN $9::boolean THEN $10::integer ELSE capture_sequence END,
    patch_parse_status = CASE WHEN $11::boolean THEN $12::text ELSE patch_parse_status END,
    patch_sha256 = CASE WHEN $13::boolean THEN $14::text ELSE patch_sha256 END,
    storage_backend = CASE WHEN $15::boolean THEN $16::text ELSE storage_backend END,
    cf_artifact_repo = CASE WHEN $17::boolean THEN $18::text ELSE cf_artifact_repo END,
    cf_artifact_commit_sha = CASE WHEN $19::boolean THEN $20::text ELSE cf_artifact_commit_sha END,
    cf_artifact_path = CASE WHEN $21::boolean THEN $22::text ELSE cf_artifact_path END,
    storage_reconciliation_status = CASE WHEN $23::boolean THEN $24::text ELSE storage_reconciliation_status END,
    updated_at = $25
  WHERE id = $1
    AND user_id = $2
`;

function hasOwn<T extends object, K extends PropertyKey>(
  value: T,
  key: K,
): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

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
