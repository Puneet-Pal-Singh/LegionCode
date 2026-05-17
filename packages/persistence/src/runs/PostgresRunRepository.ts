import type { JsonValue } from "@repo/shared-types";
import type { SqlClient, SqlRow, SqlValue } from "../sql.js";
import type {
  AppendRunEventInput,
  EnsureRunInput,
  RunEventRecord,
  RunRecord,
  RunRepository,
  UpdateRunStatusInput,
  RunStatus,
} from "./types.js";

interface Clock {
  now(): Date;
}

const systemClock: Clock = {
  now: () => new Date(),
};

export class PostgresRunRepository implements RunRepository {
  constructor(
    private readonly client: SqlClient,
    private readonly clock: Clock = systemClock,
  ) {}

  async ensureRun(input: EnsureRunInput): Promise<RunRecord> {
    const now = this.clock.now();
    const result = await this.client.query<RunRow>(UPSERT_RUN_SQL, [
      input.id,
      input.userId,
      input.workspaceId ?? null,
      input.sessionId,
      input.taskId,
      input.status ?? null,
      input.mode ?? null,
      input.providerId ?? null,
      input.modelId ?? null,
      input.branch ?? null,
      input.baseCommitSha ?? null,
      input.headCommitSha ?? null,
      now,
    ]);

    return mapRunRow(readReturnedRow(result.rows[0], "runs"));
  }

  async updateRunStatus(input: UpdateRunStatusInput): Promise<RunRecord> {
    const now = this.clock.now();
    const result = await this.client.query<RunRow>(UPDATE_RUN_STATUS_SQL, [
      input.id,
      input.status,
      input.startedAt ? new Date(input.startedAt) : null,
      input.completedAt ? new Date(input.completedAt) : null,
      now,
    ]);

    const row = result.rows[0];
    if (!row) {
      throw new Error(`Run not found: ${input.id}`);
    }

    return mapRunRow(row);
  }

  async appendEvent(input: AppendRunEventInput): Promise<RunEventRecord> {
    const now = this.clock.now();
    return await this.client.transaction(async (tx) => {
      // Serialize concurrent appends for this run
      await tx.query("SELECT id FROM runs WHERE id = $1 FOR UPDATE", [input.runId]);

      // Get the next sequence number for this run
      const seqResult = await tx.query<{ sequence: number | string }>(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM run_events WHERE run_id = $1",
        [input.runId],
      );
      const sequence = Number(seqResult.rows[0]?.sequence ?? 1);

      const result = await tx.query<RunRow>(INSERT_RUN_EVENT_SQL, [
        input.runId,
        input.sessionId,
        input.eventType,
        JSON.stringify(input.payload),
        sequence,
        input.idempotencyKey ?? null,
        now,
      ]);

      const row = result.rows[0];
      if (!row) {
        // If no row returned, it means idempotency key conflict.
        // We should fetch the existing event.
        if (!input.idempotencyKey) {
          throw new Error("Failed to insert run event without idempotency key");
        }
        return await readEventByIdempotencyKey(tx, input.runId, input.idempotencyKey);
      }

      return mapRunEventRow(row);
    });
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const result = await this.client.query<RunRow>(GET_RUN_SQL, [runId]);
    const row = result.rows[0];
    return row ? mapRunRow(row) : null;
  }

  async listRunEvents(runId: string): Promise<RunEventRecord[]> {
    const result = await this.client.query<RunRow>(LIST_RUN_EVENTS_SQL, [runId]);
    return result.rows.map(mapRunEventRow);
  }

  async transaction<T>(
    callback: (repository: RunRepository) => Promise<T>,
  ): Promise<T> {
    return await this.client.transaction(async (tx) => {
      return await callback(new PostgresRunRepository(tx, this.clock));
    });
  }
}

interface RunRow extends SqlRow {
  id?: string;
  user_id?: string;
  workspace_id?: string | null;
  session_id?: string;
  task_id?: string;
  status?: string;
  mode?: string;
  provider_id?: string | null;
  model_id?: string | null;
  branch?: string | null;
  base_commit_sha?: string | null;
  head_commit_sha?: string | null;
  started_at?: string | Date | null;
  completed_at?: string | Date | null;
  created_at?: string | Date;
  updated_at?: string | Date;
  event_id?: string;
  event_type?: string;
  payload_json?: JsonValue | string;
  sequence?: number | string;
  idempotency_key?: string | null;
}

function mapRunRow(row: RunRow): RunRecord {
  return {
    id: requireString(row.id, "id"),
    userId: requireString(row.user_id, "user_id"),
    workspaceId: row.workspace_id ?? null,
    sessionId: requireString(row.session_id, "session_id"),
    taskId: requireString(row.task_id, "task_id"),
    status: mapRunStatus(requireString(row.status, "status")),
    mode: requireString(row.mode, "mode"),
    providerId: row.provider_id ?? null,
    modelId: row.model_id ?? null,
    branch: row.branch ?? null,
    baseCommitSha: row.base_commit_sha ?? null,
    headCommitSha: row.head_commit_sha ?? null,
    startedAt: row.started_at ? toIsoString(row.started_at) : null,
    completedAt: row.completed_at ? toIsoString(row.completed_at) : null,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapRunEventRow(row: RunRow): RunEventRecord {
  return {
    id: requireString(row.event_id ?? row.id, "id"),
    runId: requireString(row.run_id ?? row.runId, "run_id"),
    sessionId: requireString(row.session_id, "session_id"),
    eventType: requireString(row.event_type, "event_type"),
    payload: parsePayloadJson(row.payload_json, row.event_id ?? row.id),
    sequence: toNumber(row.sequence),
    idempotencyKey: row.idempotency_key ?? null,
    createdAt: toIsoString(row.created_at),
  };
}

function parsePayloadJson(value: JsonValue | string | undefined, eventId: unknown): JsonValue {
  if (typeof value !== "string") {
    return value ?? null;
  }

  try {
    return JSON.parse(value) as JsonValue;
  } catch (error) {
    throw new Error(`Invalid payload_json for run_event ${String(eventId)}`, {
      cause: error,
    });
  }
}

function mapRunStatus(status: string): RunStatus {
  if (
    status === "created" ||
    status === "running" ||
    status === "completed" ||
    status === "failed" ||
    status === "cancelled"
  ) {
    return status;
  }
  throw new Error(`Unsupported run status: ${status}`);
}

async function readEventByIdempotencyKey(
  client: SqlClient,
  runId: string,
  idempotencyKey: string,
): Promise<RunEventRecord> {
  const result = await client.query<RunRow>(FIND_EVENT_BY_IDEMPOTENCY_SQL, [
    runId,
    idempotencyKey,
  ]);
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Run event not found for idempotency key: ${idempotencyKey}`);
  }
  return mapRunEventRow(row);
}

function readReturnedRow(row: RunRow | undefined, tableName: string): RunRow {
  if (!row) {
    throw new Error(`${tableName} statement returned no row`);
  }
  return row;
}

function requireString(value: unknown, columnName: string): string {
  if (typeof value === "string") {
    return value;
  }
  throw new Error(`Expected ${columnName} to be a string`);
}

function toIsoString(value: string | Date | undefined): string {
  if (!value) {
    throw new Error("Missing timestamp column");
  }
  return value instanceof Date ? value.toISOString() : value;
}

function toNumber(value: number | string | undefined): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return Number(value);
  }
  throw new Error("Missing numeric column");
}

const RUN_COLUMNS = `
  id,
  user_id,
  workspace_id,
  session_id,
  task_id,
  status,
  mode,
  provider_id,
  model_id,
  branch,
  base_commit_sha,
  head_commit_sha,
  started_at,
  completed_at,
  created_at,
  updated_at
`;

const UPSERT_RUN_SQL = `
  INSERT INTO runs (
    id,
    user_id,
    workspace_id,
    session_id,
    task_id,
    status,
    mode,
    provider_id,
    model_id,
    branch,
    base_commit_sha,
    head_commit_sha,
    created_at,
    updated_at
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
  ON CONFLICT (id)
  DO UPDATE SET
    status = COALESCE(EXCLUDED.status, runs.status),
    mode = COALESCE(EXCLUDED.mode, runs.mode),
    provider_id = COALESCE(EXCLUDED.provider_id, runs.provider_id),
    model_id = COALESCE(EXCLUDED.model_id, runs.model_id),
    branch = COALESCE(EXCLUDED.branch, runs.branch),
    base_commit_sha = COALESCE(EXCLUDED.base_commit_sha, runs.base_commit_sha),
    head_commit_sha = COALESCE(EXCLUDED.head_commit_sha, runs.head_commit_sha),
    updated_at = EXCLUDED.updated_at
  RETURNING ${RUN_COLUMNS}
`;

const UPDATE_RUN_STATUS_SQL = `
  UPDATE runs
  SET
    status = $2,
    started_at = COALESCE($3, started_at),
    completed_at = COALESCE($4, completed_at),
    updated_at = $5
  WHERE id = $1
  RETURNING ${RUN_COLUMNS}
`;

const GET_RUN_SQL = `
  SELECT ${RUN_COLUMNS}
  FROM runs
  WHERE id = $1
`;

const INSERT_RUN_EVENT_SQL = `
  INSERT INTO run_events (
    run_id,
    session_id,
    event_type,
    payload_json,
    sequence,
    idempotency_key,
    created_at
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7)
  ON CONFLICT (run_id, idempotency_key) DO NOTHING
  RETURNING
    id AS event_id,
    run_id,
    session_id,
    event_type,
    payload_json,
    sequence,
    idempotency_key,
    created_at
`;

const FIND_EVENT_BY_IDEMPOTENCY_SQL = `
  SELECT
    id AS event_id,
    run_id,
    session_id,
    event_type,
    payload_json,
    sequence,
    idempotency_key,
    created_at
  FROM run_events
  WHERE run_id = $1 AND idempotency_key = $2
`;

const LIST_RUN_EVENTS_SQL = `
  SELECT
    id AS event_id,
    run_id,
    session_id,
    event_type,
    payload_json,
    sequence,
    idempotency_key,
    created_at
  FROM run_events
  WHERE run_id = $1
  ORDER BY sequence ASC
`;
