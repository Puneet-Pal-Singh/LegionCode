import type { JsonValue } from "@repo/shared-types";
import type { SqlClient, SqlRow } from "../sql.js";
import {
  parseJsonField,
  requireRow,
  requireString,
  toJsonParam,
  toIsoString,
} from "../lib/rowMappers.js";
import type {
  AddContextSourceInput,
  ContextRepository,
  ContextSnapshotRecord,
  ContextSnapshotSourceRecord,
  CreateContextSnapshotInput,
} from "./types.js";

interface Clock {
  now(): Date;
}

const systemClock: Clock = {
  now: () => new Date(),
};

export class PostgresContextRepository implements ContextRepository {
  constructor(
    private readonly client: SqlClient,
    private readonly clock: Clock = systemClock,
  ) {}

  async createSnapshot(
    input: CreateContextSnapshotInput,
  ): Promise<ContextSnapshotRecord> {
    const now = this.clock.now();
    const result = await this.client.query<SnapshotRow>(CREATE_SNAPSHOT_SQL, [
      input.userId,
      input.sessionId,
      input.runId ?? null,
      input.snapshotKind,
      input.r2ObjectKey ?? null,
      input.payloadSizeBytes ?? null,
      input.tokenCount ?? null,
      input.triggerReason ?? null,
      toJsonParam(input.sourceMessageRangeJson),
      input.summaryMessageId ?? null,
      input.replacementHistoryR2ObjectKey ?? null,
      toJsonParam(input.usageBeforeJson),
      toJsonParam(input.usageAfterJson),
      toJsonParam(input.validationJson),
      toJsonParam(input.modelInfoJson),
      toJsonParam(input.mediaArtifactsJson),
      toJsonParam(input.continuityStateJson),
      now,
    ]);

    return mapSnapshotRow(requireRow(result.rows[0], "context_snapshots"));
  }

  async addSource(
    input: AddContextSourceInput,
  ): Promise<ContextSnapshotSourceRecord> {
    const now = this.clock.now();
    const result = await this.client.query<SourceRow>(ADD_SOURCE_SQL, [
      input.contextSnapshotId,
      input.sourceType,
      input.sourceId,
      toJsonParam(input.sourceRangeJson),
      now,
    ]);

    return mapSourceRow(requireRow(result.rows[0], "context_snapshot_sources"));
  }

  async listSnapshotsBySession(
    sessionId: string,
    userId?: string,
  ): Promise<ContextSnapshotRecord[]> {
    const result = await this.client.query<SnapshotRow>(
      LIST_SNAPSHOTS_SQL,
      [sessionId, userId ?? null],
    );

    return result.rows.map(mapSnapshotRow);
  }

  async listSourcesBySnapshot(
    snapshotId: string,
    userId?: string,
  ): Promise<ContextSnapshotSourceRecord[]> {
    const result = await this.client.query<SourceRow>(LIST_SOURCES_SQL, [
      snapshotId,
      userId ?? null,
    ]);

    return result.rows.map(mapSourceRow);
  }

  async transaction<T>(
    callback: (repository: ContextRepository) => Promise<T>,
  ): Promise<T> {
    return await this.client.transaction(async (tx) => {
      return await callback(new PostgresContextRepository(tx, this.clock));
    });
  }
}

interface SnapshotRow extends SqlRow {
  id?: string;
  user_id?: string;
  session_id?: string;
  run_id?: string | null;
  snapshot_kind?: string;
  r2_object_key?: string | null;
  payload_size_bytes?: number | null;
  token_count?: number | null;
  trigger_reason?: string | null;
  source_message_range_json?: JsonValue | string | null;
  summary_message_id?: string | null;
  replacement_history_r2_object_key?: string | null;
  usage_before_json?: JsonValue | string | null;
  usage_after_json?: JsonValue | string | null;
  validation_json?: JsonValue | string | null;
  model_info_json?: JsonValue | string | null;
  media_artifacts_json?: JsonValue | string | null;
  continuity_state_json?: JsonValue | string | null;
  created_at?: string | Date;
}

interface SourceRow extends SqlRow {
  id?: string;
  context_snapshot_id?: string;
  source_type?: string;
  source_id?: string;
  source_range_json?: JsonValue | string | null;
  created_at?: string | Date;
}

function mapSnapshotRow(row: SnapshotRow): ContextSnapshotRecord {
  return {
    id: requireString(row.id, "id"),
    userId: requireString(row.user_id, "user_id"),
    sessionId: requireString(row.session_id, "session_id"),
    runId: row.run_id ?? null,
    snapshotKind: requireString(row.snapshot_kind, "snapshot_kind"),
    r2ObjectKey: row.r2_object_key ?? null,
    payloadSizeBytes: row.payload_size_bytes ?? null,
    tokenCount: row.token_count ?? null,
    triggerReason: row.trigger_reason ?? null,
    sourceMessageRangeJson: parseJsonField(
      row.source_message_range_json,
      "context_snapshots.source_message_range_json",
    ),
    summaryMessageId: row.summary_message_id ?? null,
    replacementHistoryR2ObjectKey:
      row.replacement_history_r2_object_key ?? null,
    usageBeforeJson: parseJsonField(
      row.usage_before_json,
      "context_snapshots.usage_before_json",
    ),
    usageAfterJson: parseJsonField(
      row.usage_after_json,
      "context_snapshots.usage_after_json",
    ),
    validationJson: parseJsonField(
      row.validation_json,
      "context_snapshots.validation_json",
    ),
    modelInfoJson: parseJsonField(
      row.model_info_json,
      "context_snapshots.model_info_json",
    ),
    mediaArtifactsJson: parseJsonField(
      row.media_artifacts_json,
      "context_snapshots.media_artifacts_json",
    ),
    continuityStateJson: parseJsonField(
      row.continuity_state_json,
      "context_snapshots.continuity_state_json",
    ),
    createdAt: toIsoString(row.created_at),
  };
}

function mapSourceRow(row: SourceRow): ContextSnapshotSourceRecord {
  return {
    id: requireString(row.id, "id"),
    contextSnapshotId: requireString(
      row.context_snapshot_id,
      "context_snapshot_id",
    ),
    sourceType: requireString(row.source_type, "source_type"),
    sourceId: requireString(row.source_id, "source_id"),
    sourceRangeJson: parseJsonField(
      row.source_range_json,
      "context_snapshot_sources.source_range_json",
    ),
    createdAt: toIsoString(row.created_at),
  };
}

const CREATE_SNAPSHOT_SQL = `
  INSERT INTO context_snapshots (
    user_id,
    session_id,
    run_id,
    snapshot_kind,
    r2_object_key,
    payload_size_bytes,
    token_count,
    trigger_reason,
    source_message_range_json,
    summary_message_id,
    replacement_history_r2_object_key,
    usage_before_json,
    usage_after_json,
    validation_json,
    model_info_json,
    media_artifacts_json,
    continuity_state_json,
    created_at
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb, $18)
  RETURNING
    id,
    user_id,
    session_id,
    run_id,
    snapshot_kind,
    r2_object_key,
    payload_size_bytes,
    token_count,
    trigger_reason,
    source_message_range_json,
    summary_message_id,
    replacement_history_r2_object_key,
    usage_before_json,
    usage_after_json,
    validation_json,
    model_info_json,
    media_artifacts_json,
    continuity_state_json,
    created_at
`;

const ADD_SOURCE_SQL = `
  INSERT INTO context_snapshot_sources (context_snapshot_id, source_type, source_id, source_range_json, created_at)
  VALUES ($1, $2, $3, $4::jsonb, $5)
  RETURNING
    id, context_snapshot_id, source_type, source_id, source_range_json, created_at
`;

const LIST_SNAPSHOTS_SQL = `
  SELECT
    id,
    user_id,
    session_id,
    run_id,
    snapshot_kind,
    r2_object_key,
    payload_size_bytes,
    token_count,
    trigger_reason,
    source_message_range_json,
    summary_message_id,
    replacement_history_r2_object_key,
    usage_before_json,
    usage_after_json,
    validation_json,
    model_info_json,
    media_artifacts_json,
    continuity_state_json,
    created_at
  FROM context_snapshots
  WHERE session_id = $1
    AND ($2::uuid IS NULL OR user_id = $2::uuid)
  ORDER BY created_at DESC
`;

const LIST_SOURCES_SQL = `
  SELECT
    sources.id,
    sources.context_snapshot_id,
    sources.source_type,
    sources.source_id,
    sources.source_range_json,
    sources.created_at
  FROM context_snapshot_sources sources
  INNER JOIN context_snapshots snapshots
    ON snapshots.id = sources.context_snapshot_id
  WHERE sources.context_snapshot_id = $1
    AND ($2::uuid IS NULL OR snapshots.user_id = $2::uuid)
  ORDER BY sources.created_at ASC
`;
