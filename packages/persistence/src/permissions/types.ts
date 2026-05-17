import type { JsonValue } from "@repo/shared-types";

export const PERMISSION_REQUEST_STATUSES = [
  "pending",
  "resolved",
  "expired",
  "aborted",
] as const;

export type PermissionRequestStatus =
  (typeof PERMISSION_REQUEST_STATUSES)[number];

export const PERMISSION_DECISION_KINDS = [
  "allow_once",
  "allow_for_run",
  "allow_persistent_rule",
  "deny",
  "abort",
] as const;

export type PermissionDecisionKind =
  (typeof PERMISSION_DECISION_KINDS)[number];

function buildSqlList(values: readonly string[]): string {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
}

export function buildPermissionRequestStatusSqlList(): string {
  return buildSqlList(PERMISSION_REQUEST_STATUSES);
}

export function buildPermissionDecisionKindSqlList(): string {
  return buildSqlList(PERMISSION_DECISION_KINDS);
}

export function resolvePermissionRequestStatus(
  decision: PermissionDecisionKind,
): PermissionRequestStatus {
  return decision === "abort" ? "aborted" : "resolved";
}

export interface PermissionRequestRecord {
  id: string;
  userId: string;
  sessionId: string;
  runId: string;
  requestType: string;
  status: PermissionRequestStatus;
  payload: JsonValue | null;
  expiresAt: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface PermissionDecisionRecord {
  id: string;
  permissionRequestId: string;
  userId: string;
  decision: PermissionDecisionKind;
  payload: JsonValue | null;
  createdAt: string;
}

export interface CreatePermissionRequestInput {
  userId: string;
  sessionId: string;
  runId: string;
  requestType: string;
  status?: PermissionRequestStatus;
  payload?: JsonValue | null;
  expiresAt?: string | null;
}

export interface CreatePermissionDecisionInput {
  permissionRequestId: string;
  userId: string;
  decision: PermissionDecisionKind;
  payload?: JsonValue | null;
}

export interface PermissionRepository {
  createRequest(input: CreatePermissionRequestInput): Promise<PermissionRequestRecord>;
  createDecision(input: CreatePermissionDecisionInput): Promise<PermissionDecisionRecord>;
  listRequestsByRun(runId: string, userId?: string): Promise<PermissionRequestRecord[]>;
  listDecisionsByRequest(
    requestId: string,
    userId?: string,
  ): Promise<PermissionDecisionRecord[]>;
  transaction<T>(
    callback: (repository: PermissionRepository) => Promise<T>,
  ): Promise<T>;
}
