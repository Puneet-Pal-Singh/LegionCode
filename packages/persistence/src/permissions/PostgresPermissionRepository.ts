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
  CreatePermissionDecisionInput,
  CreatePermissionRequestInput,
  PermissionDecisionRecord,
  PermissionRepository,
  PermissionRequestRecord,
} from "./types.js";
import {
  PERMISSION_DECISION_KINDS,
  PERMISSION_REQUEST_STATUSES,
  resolvePermissionRequestStatus,
} from "./types.js";

interface Clock {
  now(): Date;
}

const systemClock: Clock = {
  now: () => new Date(),
};

export class PostgresPermissionRepository implements PermissionRepository {
  constructor(
    private readonly client: SqlClient,
    private readonly clock: Clock = systemClock,
  ) {}

  async createRequest(
    input: CreatePermissionRequestInput,
  ): Promise<PermissionRequestRecord> {
    const now = this.clock.now();
    const result = await this.client.query<RequestRow>(CREATE_REQUEST_SQL, [
      input.userId,
      input.sessionId,
      input.runId,
      input.requestType,
      input.status ?? "pending",
      toJsonParam(input.payload),
      input.expiresAt ? new Date(input.expiresAt) : null,
      now,
    ]);

    return mapRequestRow(requireRow(result.rows[0], "permission_requests"));
  }

  async createDecision(
    input: CreatePermissionDecisionInput,
  ): Promise<PermissionDecisionRecord> {
    const now = this.clock.now();
    const result = await this.client.query<DecisionRow>(CREATE_DECISION_SQL, [
      input.permissionRequestId,
      input.userId,
      input.decision,
      toJsonParam(input.payload),
      now,
      resolvePermissionRequestStatus(input.decision),
    ]);

    return mapDecisionRow(requireRow(result.rows[0], "permission_decisions"));
  }

  async listRequestsByRun(
    runId: string,
    userId?: string,
  ): Promise<PermissionRequestRecord[]> {
    const result = await this.client.query<RequestRow>(LIST_REQUESTS_SQL, [
      runId,
      userId ?? null,
    ]);

    return result.rows.map(mapRequestRow);
  }

  async listDecisionsByRequest(
    requestId: string,
    userId?: string,
  ): Promise<PermissionDecisionRecord[]> {
    const result = await this.client.query<DecisionRow>(LIST_DECISIONS_SQL, [
      requestId,
      userId ?? null,
    ]);

    return result.rows.map(mapDecisionRow);
  }

  async transaction<T>(
    callback: (repository: PermissionRepository) => Promise<T>,
  ): Promise<T> {
    return await this.client.transaction(async (tx) => {
      return await callback(
        new PostgresPermissionRepository(tx, this.clock),
      );
    });
  }
}

interface RequestRow extends SqlRow {
  id?: string;
  user_id?: string;
  session_id?: string;
  run_id?: string;
  request_type?: string;
  status?: string;
  payload_json?: JsonValue | string | null;
  expires_at?: string | Date | null;
  created_at?: string | Date;
  resolved_at?: string | Date | null;
}

interface DecisionRow extends SqlRow {
  id?: string;
  permission_request_id?: string;
  user_id?: string;
  decision?: string;
  payload_json?: JsonValue | string | null;
  created_at?: string | Date;
}

function mapRequestRow(row: RequestRow): PermissionRequestRecord {
  return {
    id: requireString(row.id, "id"),
    userId: requireString(row.user_id, "user_id"),
    sessionId: requireString(row.session_id, "session_id"),
    runId: requireString(row.run_id, "run_id"),
    requestType: requireString(row.request_type, "request_type"),
    status: validateRequestStatus(
      requireString(row.status, "status"),
    ),
    payload: parseJsonField(row.payload_json, "permission_requests.payload_json"),
    expiresAt: row.expires_at ? toIsoString(row.expires_at) : null,
    createdAt: toIsoString(row.created_at),
    resolvedAt: row.resolved_at ? toIsoString(row.resolved_at) : null,
  };
}

function mapDecisionRow(row: DecisionRow): PermissionDecisionRecord {
  return {
    id: requireString(row.id, "id"),
    permissionRequestId: requireString(
      row.permission_request_id,
      "permission_request_id",
    ),
    userId: requireString(row.user_id, "user_id"),
    decision: validateDecisionKind(requireString(row.decision, "decision")),
    payload: parseJsonField(row.payload_json, "permission_decisions.payload_json"),
    createdAt: toIsoString(row.created_at),
  };
}

function validateRequestStatus(
  status: string,
): (typeof PERMISSION_REQUEST_STATUSES)[number] {
  if (
    PERMISSION_REQUEST_STATUSES.includes(
      status as (typeof PERMISSION_REQUEST_STATUSES)[number],
    )
  ) {
    return status as (typeof PERMISSION_REQUEST_STATUSES)[number];
  }
  throw new Error(`Unsupported permission request status: ${status}`);
}

function validateDecisionKind(
  kind: string,
): (typeof PERMISSION_DECISION_KINDS)[number] {
  if (
    PERMISSION_DECISION_KINDS.includes(
      kind as (typeof PERMISSION_DECISION_KINDS)[number],
    )
  ) {
    return kind as (typeof PERMISSION_DECISION_KINDS)[number];
  }
  throw new Error(`Unsupported permission decision kind: ${kind}`);
}

const CREATE_REQUEST_SQL = `
  INSERT INTO permission_requests (user_id, session_id, run_id, request_type, status, payload_json, expires_at, created_at)
  VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
  RETURNING
    id, user_id, session_id, run_id, request_type, status, payload_json, expires_at, created_at, resolved_at
`;

const CREATE_DECISION_SQL = `
  WITH scoped_request AS (
    SELECT id
    FROM permission_requests
    WHERE id = $1
      AND user_id = $2
  ),
  inserted AS (
    INSERT INTO permission_decisions (
      permission_request_id,
      user_id,
      decision,
      payload_json,
      created_at
    )
    SELECT id, $2, $3, $4::jsonb, $5
    FROM scoped_request
    RETURNING
      id,
      permission_request_id,
      user_id,
      decision,
      payload_json,
      created_at
  ),
  resolved_request AS (
    UPDATE permission_requests
    SET status = $6, resolved_at = $5
    WHERE id = $1
      AND user_id = $2
      AND EXISTS (SELECT 1 FROM inserted)
    RETURNING id
  )
  SELECT
    id,
    permission_request_id,
    user_id,
    decision,
    payload_json,
    created_at
  FROM inserted
`;

const LIST_REQUESTS_SQL = `
  SELECT
    id, user_id, session_id, run_id, request_type, status, payload_json, expires_at, created_at, resolved_at
  FROM permission_requests
  WHERE run_id = $1
    AND ($2::uuid IS NULL OR user_id = $2::uuid)
  ORDER BY created_at DESC
`;

const LIST_DECISIONS_SQL = `
  SELECT
    decisions.id,
    decisions.permission_request_id,
    decisions.user_id,
    decisions.decision,
    decisions.payload_json,
    decisions.created_at
  FROM permission_decisions decisions
  INNER JOIN permission_requests requests
    ON requests.id = decisions.permission_request_id
  WHERE decisions.permission_request_id = $1
    AND ($2::uuid IS NULL OR requests.user_id = $2::uuid)
  ORDER BY decisions.created_at ASC
`;
