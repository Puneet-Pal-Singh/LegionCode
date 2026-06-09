import type { SqlClient } from "../sql.js";
import type {
  AppendRunEventInput,
  EnsureRunInput,
  RunEventRecord,
  RunRecord,
  RunRepository,
  RunStepRecord,
  UpdateRunStatusInput,
  UpsertRunStepInput,
} from "./types.js";
import {
  type RunRow,
  mapRunRow,
  mapRunEventRow,
  mapRunStepRow,
  readReturnedRow,
} from "./runMappers.js";

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
    const result = await this.client.query<RunRow>(APPEND_RUN_EVENT_SQL, [
      input.runId,
      input.sessionId,
      input.eventType,
      JSON.stringify(input.payload),
      input.idempotencyKey ?? null,
      now,
    ]);

    const row = result.rows[0];
    if (!row) {
      throw new Error(`Run event append returned no row for run: ${input.runId}`);
    }

    return mapRunEventRow(row);
  }

  async upsertStep(input: UpsertRunStepInput): Promise<RunStepRecord> {
    const now = this.clock.now();
    const result = await this.client.query<RunRow>(UPSERT_RUN_STEP_SQL, [
      input.runId,
      input.stepIndex,
      input.stepType,
      input.status,
      input.startedAt ? new Date(input.startedAt) : null,
      input.completedAt ? new Date(input.completedAt) : null,
      JSON.stringify(input.payload),
      now,
    ]);

    return mapRunStepRow(readReturnedRow(result.rows[0], "run_steps"));
  }

  async getRun(runId: string, userId?: string): Promise<RunRecord | null> {
    const result = await this.client.query<RunRow>(GET_RUN_SQL, [
      runId,
      userId ?? null,
    ]);
    const row = result.rows[0];
    return row ? mapRunRow(row) : null;
  }

  async listRunEvents(runId: string, userId?: string): Promise<RunEventRecord[]> {
    const result = await this.client.query<RunRow>(LIST_RUN_EVENTS_SQL, [
      runId,
      userId ?? null,
    ]);
    return result.rows.map(mapRunEventRow);
  }

  async listRunSteps(runId: string, userId?: string): Promise<RunStepRecord[]> {
    const result = await this.client.query<RunRow>(LIST_RUN_STEPS_SQL, [
      runId,
      userId ?? null,
    ]);
    return result.rows.map(mapRunStepRow);
  }

  async transaction<T>(
    callback: (repository: RunRepository) => Promise<T>,
  ): Promise<T> {
    return await this.client.transaction(async (tx) => {
      return await callback(new PostgresRunRepository(tx, this.clock));
    });
  }
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
  VALUES (
    $1,
    $2,
    $3,
    $4,
    $5,
    COALESCE($6::text, 'created'),
    COALESCE($7::text, 'build'),
    $8,
    $9,
    $10,
    $11,
    $12,
    $13,
    $13
  )
  ON CONFLICT (id)
  DO UPDATE SET
    status = COALESCE($6::text, runs.status),
    mode = COALESCE($7::text, runs.mode),
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
    AND ($2::uuid IS NULL OR user_id = $2::uuid)
`;

const APPEND_RUN_EVENT_SQL = `
  WITH locked AS (
    SELECT id FROM runs WHERE id = $1 FOR UPDATE
  ),
  existing AS (
    SELECT
      run_events.id AS event_id,
      run_events.run_id,
      run_events.session_id,
      run_events.event_type,
      run_events.payload_json,
      run_events.sequence,
      run_events.idempotency_key,
      run_events.created_at
    FROM run_events
    JOIN locked ON locked.id = run_events.run_id
    WHERE run_events.run_id = $1
      AND $5::text IS NOT NULL
      AND run_events.idempotency_key = $5::text
  ),
  next_seq AS (
    UPDATE runs
    SET last_sequence = last_sequence + 1
    FROM locked
    WHERE runs.id = locked.id
      AND NOT EXISTS (SELECT 1 FROM existing)
    RETURNING last_sequence
  ),
  inserted AS (
    INSERT INTO run_events (run_id, session_id, event_type, payload_json, sequence, idempotency_key, created_at)
    SELECT $1, $2, $3, $4, last_sequence, $5::text, $6 FROM next_seq
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
  )
  SELECT * FROM existing
  UNION ALL
  SELECT * FROM inserted
`;

const LIST_RUN_EVENTS_SQL = `
  SELECT
    e.id AS event_id,
    e.run_id,
    e.session_id,
    e.event_type,
    e.payload_json,
    e.sequence,
    e.idempotency_key,
    e.created_at
  FROM run_events e
  JOIN runs r ON r.id = e.run_id
  WHERE e.run_id = $1
    AND ($2::uuid IS NULL OR r.user_id = $2::uuid)
  ORDER BY e.sequence ASC
`;

const RUN_STEP_COLUMNS = `
  id AS step_id,
  run_id,
  step_index,
  step_type,
  status AS step_status,
  started_at AS step_started_at,
  completed_at AS step_completed_at,
  payload_json AS step_payload_json,
  created_at AS step_created_at,
  updated_at AS step_updated_at
`;

const RUN_STEP_SELECT_COLUMNS = `
  s.id AS step_id,
  s.run_id,
  s.step_index,
  s.step_type,
  s.status AS step_status,
  s.started_at AS step_started_at,
  s.completed_at AS step_completed_at,
  s.payload_json AS step_payload_json,
  s.created_at AS step_created_at,
  s.updated_at AS step_updated_at
`;

const UPSERT_RUN_STEP_SQL = `
  INSERT INTO run_steps (
    run_id,
    step_index,
    step_type,
    status,
    started_at,
    completed_at,
    payload_json,
    created_at,
    updated_at
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8)
  ON CONFLICT (run_id, step_index)
  DO UPDATE SET
    step_type = EXCLUDED.step_type,
    status = EXCLUDED.status,
    started_at = COALESCE(EXCLUDED.started_at, run_steps.started_at),
    completed_at = COALESCE(EXCLUDED.completed_at, run_steps.completed_at),
    payload_json = EXCLUDED.payload_json,
    updated_at = EXCLUDED.updated_at
  RETURNING ${RUN_STEP_COLUMNS}
`;

const LIST_RUN_STEPS_SQL = `
  SELECT ${RUN_STEP_SELECT_COLUMNS}
  FROM run_steps s
  JOIN runs r ON r.id = s.run_id
  WHERE s.run_id = $1
    AND ($2::uuid IS NULL OR r.user_id = $2::uuid)
  ORDER BY s.step_index ASC
`;
