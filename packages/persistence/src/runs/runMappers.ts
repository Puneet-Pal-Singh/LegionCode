import type { JsonValue } from "@repo/shared-types";
import type { SqlRow } from "../sql.js";
import type {
  RunEventRecord,
  RunRecord,
  RunStatus,
  RunStepRecord,
  RunStepStatus,
} from "./types.js";

export interface RunRow extends SqlRow {
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
  event_id: string;
  event_type: string;
  payload_json: JsonValue | string;
  sequence: number | string;
  idempotency_key: string | null;
  step_id?: string;
  step_index?: number | string;
  step_type?: string;
  step_status?: string;
  step_started_at?: string | Date | null;
  step_completed_at?: string | Date | null;
  step_payload_json?: JsonValue | string;
  step_created_at?: string | Date;
  step_updated_at?: string | Date;
}

export function mapRunRow(row: RunRow): RunRecord {
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

export function mapRunEventRow(row: RunRow): RunEventRecord {
  return {
    id: requireString(row.event_id, "event_id"),
    runId: requireString(row.run_id, "run_id"),
    sessionId: requireString(row.session_id, "session_id"),
    eventType: requireString(row.event_type, "event_type"),
    payload: parsePayloadJson(row.payload_json, row.event_id),
    sequence: toNumber(row.sequence),
    idempotencyKey: row.idempotency_key ?? null,
    createdAt: toIsoString(row.created_at),
  };
}

export function mapRunStepRow(row: RunRow): RunStepRecord {
  return {
    id: requireString(row.step_id, "step_id"),
    runId: requireString(row.run_id, "run_id"),
    stepIndex: toNumber(row.step_index),
    stepType: requireString(row.step_type, "step_type"),
    status: mapRunStepStatus(requireString(row.step_status, "step_status")),
    startedAt: row.step_started_at ? toIsoString(row.step_started_at) : null,
    completedAt: row.step_completed_at
      ? toIsoString(row.step_completed_at)
      : null,
    payload: parsePayloadJson(row.step_payload_json, row.step_id),
    createdAt: toIsoString(row.step_created_at),
    updatedAt: toIsoString(row.step_updated_at),
  };
}

export function parsePayloadJson(
  value: JsonValue | string | undefined,
  eventId: unknown,
): JsonValue {
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

export function mapRunStatus(status: string): RunStatus {
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

function mapRunStepStatus(status: string): RunStepStatus {
  if (
    status === "pending" ||
    status === "running" ||
    status === "completed" ||
    status === "failed" ||
    status === "cancelled"
  ) {
    return status;
  }
  throw new Error(`Unsupported run step status: ${status}`);
}

export function readReturnedRow(
  row: RunRow | undefined,
  tableName: string,
): RunRow {
  if (!row) {
    throw new Error(`${tableName} statement returned no row`);
  }
  return row;
}

export function requireString(value: unknown, columnName: string): string {
  if (typeof value === "string") {
    return value;
  }
  throw new Error(`Expected ${columnName} to be a string`);
}

export function toIsoString(value: string | Date | undefined): string {
  if (!value) {
    throw new Error("Missing timestamp column");
  }
  return value instanceof Date ? value.toISOString() : value;
}

export function toNumber(value: number | string | undefined): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return Number(value);
  }
  throw new Error("Missing numeric column");
}
