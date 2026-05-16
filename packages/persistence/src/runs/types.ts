import type { JsonValue } from "@repo/shared-types";

export const RUN_STATUSES = ["created", "running", "completed", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_STEP_STATUSES = ["pending", "running", "completed", "failed", "cancelled"] as const;
export type RunStepStatus = (typeof RUN_STEP_STATUSES)[number];

export function buildSqlList(values: readonly string[]): string {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
}

export function buildRunStatusSqlList(): string {
  return buildSqlList(RUN_STATUSES);
}

export function buildRunStepStatusSqlList(): string {
  return buildSqlList(RUN_STEP_STATUSES);
}

export interface RunRecord {
  id: string;
  userId: string;
  workspaceId: string | null;
  sessionId: string;
  taskId: string;
  status: RunStatus;
  mode: string;
  providerId: string | null;
  modelId: string | null;
  branch: string | null;
  baseCommitSha: string | null;
  headCommitSha: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunStepRecord {
  id: string;
  runId: string;
  stepIndex: number;
  stepType: string;
  status: RunStepStatus;
  startedAt: string | null;
  completedAt: string | null;
  payload: JsonValue;
}

export interface RunEventRecord {
  id: string;
  runId: string;
  sessionId: string;
  eventType: string;
  payload: JsonValue;
  sequence: number;
  idempotencyKey: string | null;
  createdAt: string;
}

export interface EnsureRunInput {
  id: string;
  userId: string;
  workspaceId?: string | null;
  sessionId: string;
  taskId: string;
  status?: RunStatus;
  mode?: string;
  providerId?: string | null;
  modelId?: string | null;
  branch?: string | null;
  baseCommitSha?: string | null;
  headCommitSha?: string | null;
}

export interface UpdateRunStatusInput {
  id: string;
  status: RunStatus;
  startedAt?: string;
  completedAt?: string;
}

export interface AppendRunEventInput {
  runId: string;
  sessionId: string;
  eventType: string;
  payload: JsonValue;
  idempotencyKey?: string | null;
}

export interface RunRepository {
  ensureRun(input: EnsureRunInput): Promise<RunRecord>;
  updateRunStatus(input: UpdateRunStatusInput): Promise<RunRecord>;
  appendEvent(input: AppendRunEventInput): Promise<RunEventRecord>;
  getRun(runId: string): Promise<RunRecord | null>;
  listRunEvents(runId: string): Promise<RunEventRecord[]>;
  transaction<T>(callback: (repository: RunRepository) => Promise<T>): Promise<T>;
}
