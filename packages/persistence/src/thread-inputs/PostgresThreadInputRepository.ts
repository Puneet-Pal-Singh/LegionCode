import {
  RunAttemptIdSchema,
  ThreadInputQueueSnapshotSchema,
  ThreadInputReceiptSchema,
  TurnIdSchema,
} from "@repo/platform-protocol";
import type { SqlClient, SqlRow } from "../sql.js";
import type {
  CreateThreadInput,
  StoredThreadInput,
  ThreadInputMutation,
  ThreadInputRepository,
  ThreadInputScope,
  UpdateThreadInput,
} from "./types.js";

interface InputRow extends SqlRow {
  id?: string;
  session_id?: string;
  user_id?: string;
  thread_id?: string;
  workspace_id?: string;
  client_input_id?: string;
  fingerprint?: string;
  delivery?: "queue" | "steer";
  target_turn_id?: string | null;
  target_run_attempt_id?: string | null;
  content_json?: unknown;
  configuration_json?: unknown;
  order_number?: number | string;
  version?: number | string;
  state?: StoredThreadInput["state"];
  receipt_json?: unknown;
  revision?: number | string;
  paused?: boolean;
  pause_reason?: string | null;
  active_run_id?: string | null;
}

export class PostgresThreadInputRepository implements ThreadInputRepository {
  constructor(private readonly client: SqlClient) {}

  async enqueue(input: CreateThreadInput): Promise<{ item: StoredThreadInput; revision: number; duplicate: boolean }> {
    return await this.client.transaction(async (tx) => {
      await assertOwnedScope(tx, input);
      const state = await lockState(tx, input);
      const existing = await tx.query<InputRow>(READ_CLIENT_INPUT_SQL, [
        input.threadId,
        input.workspaceId,
        input.clientInputId,
      ]);
      if (existing.rows[0]) {
        const item = mapInput(existing.rows[0]);
        if (item.fingerprint !== input.fingerprint) {
          throw new ThreadInputConflictError("Client input ID was reused with different content", "client_input_conflict");
        }
        return { item, revision: state.revision, duplicate: true };
      }
      if (input.delivery === "steer" && (!input.targetTurnId || !input.targetRunAttemptId)) {
        throw new ThreadInputConflictError("Steering requires an exact active turn and attempt", "turn_not_active");
      }
      const orderResult = await tx.query<InputRow>(ALLOCATE_INPUT_ORDER_SQL, [input.sessionId]);
      const order = requiredNumber(orderResult.rows[0]?.order_number, "order_number");
      const inserted = await tx.query<InputRow>(INSERT_INPUT_SQL, [
        input.sessionId,
        input.userId,
        input.threadId,
        input.workspaceId,
        input.clientInputId,
        input.fingerprint,
        input.delivery,
        input.targetTurnId ?? null,
        input.targetRunAttemptId ?? null,
        JSON.stringify({ text: input.text, mediaRefs: input.mediaRefs }),
        JSON.stringify(input.configuration),
        order,
      ]);
      const revision = await incrementRevision(tx, input.sessionId);
      return {
        item: mapInput(requiredRow(inserted.rows[0])),
        revision,
        duplicate: false,
      };
    });
  }

  async list(input: ThreadInputScope) {
    return await this.client.transaction(async (tx) => {
      await assertOwnedScope(tx, input);
      const state = await tx.query<InputRow>(READ_STATE_SQL, [input.sessionId]);
      const items = await tx.query<InputRow>(READ_INPUTS_SQL, [input.sessionId]);
      const active = await tx.query<InputRow>(READ_ACTIVE_RUN_SQL, [input.sessionId, input.userId, input.threadId, input.workspaceId]);
      const latestStarted = await tx.query<InputRow>(READ_LATEST_STARTED_SQL, [input.sessionId]);
      const stateRow = state.rows[0];
      const startedRow = latestStarted.rows[0];
      const startedReceipt = startedRow?.receipt_json == null
        ? null
        : ThreadInputReceiptSchema.parse(startedRow.receipt_json);
      return ThreadInputQueueSnapshotSchema.parse({
        threadId: input.threadId,
        workspaceId: input.workspaceId,
        revision: stateRow ? requiredNumber(stateRow.revision, "revision") : 0,
        paused: stateRow?.paused === true,
        pauseReason: stateRow?.pause_reason ?? null,
        activeRunId: active.rows[0]?.active_run_id ?? null,
        latestStarted: startedReceipt?.status === "started"
          ? { order: requiredNumber(startedRow?.order_number, "order_number"), receipt: startedReceipt }
          : null,
        items: items.rows.map((row) => {
          const item = mapInput(row);
          return {
            itemId: item.itemId,
            clientInputId: item.clientInputId,
            order: item.order,
            version: item.version,
            state: item.state,
            delivery: item.delivery,
            targetTurnId: item.targetTurnId,
            targetRunAttemptId: item.targetRunAttemptId,
            text: item.text,
            mediaRefs: item.mediaRefs,
            configuration: item.configuration,
            receipt: item.receipt,
          };
        }),
      });
    });
  }

  async getById(input: ThreadInputScope & { itemId: string }): Promise<StoredThreadInput | null> {
    return await this.client.transaction(async (tx) => {
      await assertOwnedScope(tx, input);
      return await readOwnedInput(tx, input, input.itemId);
    });
  }

  async update(input: UpdateThreadInput): Promise<ThreadInputMutation> {
    return await this.client.transaction(async (tx) => {
      await assertOwnedScope(tx, input);
      await lockState(tx, input);
      const current = await readOwnedInput(tx, input, input.itemId);
      if (!current || current.state !== "pending" || current.version !== input.expectedVersion) {
        return { status: "conflict", code: current && current.state !== "pending" ? "queue_item_consumed" : "queue_item_changed" };
      }
      const content = {
        text: input.text,
        mediaRefs: input.mediaRefs ?? current.mediaRefs,
      };
      const result = await tx.query<InputRow>(UPDATE_INPUT_SQL, [
        input.sessionId,
        input.itemId,
        input.expectedVersion,
        JSON.stringify(content),
        input.configuration ? JSON.stringify(input.configuration) : null,
      ]);
      const revision = await incrementRevision(tx, input.sessionId);
      return { status: "changed", item: mapInput(requiredRow(result.rows[0])), revision };
    });
  }

  async claimForSteering(input: import("./types.js").ClaimQueuedInputForSteering): Promise<ThreadInputMutation & { readonly revision?: number }> {
    return await this.client.transaction(async (tx) => {
      await assertOwnedScope(tx, input);
      await lockState(tx, input);
      const current = await readOwnedInput(tx, input, input.itemId);
      if (
        !current ||
        current.delivery !== "queue" ||
        current.state !== "pending" ||
        current.version !== input.expectedVersion
      ) {
        return {
          status: "conflict",
          code: current && current.state !== "pending" ? "queue_item_consumed" : "queue_item_changed",
        };
      }
      const updated = await tx.query<InputRow>(CLAIM_QUEUED_INPUT_FOR_STEERING_SQL, [
        input.sessionId,
        input.itemId,
        input.expectedVersion,
        input.targetTurnId,
        input.targetRunAttemptId,
      ]);
      if (!updated.rows[0]) {
        return { status: "conflict", code: "queue_item_changed" };
      }
      const revision = await incrementRevision(tx, input.sessionId);
      return { status: "changed", item: mapInput(updated.rows[0]), revision };
    });
  }

  async remove(input: ThreadInputScope & { itemId: string; expectedVersion: number }): Promise<ThreadInputMutation> {
    return await this.client.transaction(async (tx) => {
      await assertOwnedScope(tx, input);
      await lockState(tx, input);
      const current = await readOwnedInput(tx, input, input.itemId);
      if (!current || current.state !== "pending" || current.version !== input.expectedVersion) {
        return { status: "conflict", code: current && current.state !== "pending" ? "queue_item_consumed" : "queue_item_changed" };
      }
      const result = await tx.query<InputRow>(REMOVE_INPUT_SQL, [input.sessionId, input.itemId, input.expectedVersion]);
      const revision = await incrementRevision(tx, input.sessionId);
      const updated = requiredRow(result.rows[0]);
      const receipt = ThreadInputReceiptSchema.parse({
        status: "cancelled",
        itemId: updated.id,
        version: Number(updated.version),
        revision,
      });
      const withReceipt = await tx.query<InputRow>(RECORD_CANCELLATION_RECEIPT_SQL, [input.sessionId, input.itemId, JSON.stringify(receipt)]);
      return { status: "changed", item: mapInput(requiredRow(withReceipt.rows[0])), revision };
    });
  }

  async setPaused(input: ThreadInputScope & { paused: boolean; reason: string | null }): Promise<number> {
    return await this.client.transaction(async (tx) => {
      await assertOwnedScope(tx, input);
      await lockState(tx, input);
      const result = await tx.query<InputRow>(SET_PAUSED_SQL, [input.sessionId, input.paused, input.paused ? input.reason : null]);
      return requiredNumber(result.rows[0]?.revision, "revision");
    });
  }

  async recordReceipt(input: ThreadInputScope & { itemId: string; expectedVersion: number; receipt: import("@repo/platform-protocol").ThreadInputReceipt; state: StoredThreadInput["state"] }): Promise<ThreadInputMutation> {
    const receipt = ThreadInputReceiptSchema.parse(input.receipt);
    return await this.client.transaction(async (tx) => {
      await assertOwnedScope(tx, input);
      await lockState(tx, input);
      const current = await readOwnedInput(tx, input, input.itemId);
      if (!current || current.version !== input.expectedVersion) {
        return { status: "conflict", code: current && current.state !== "pending" ? "queue_item_consumed" : "queue_item_changed" };
      }
      const result = await tx.query<InputRow>(RECORD_RECEIPT_SQL, [input.sessionId, input.itemId, input.expectedVersion, input.state, JSON.stringify(receipt)]);
      const revision = await incrementRevision(tx, input.sessionId);
      return { status: "changed", item: mapInput(requiredRow(result.rows[0])), revision };
    });
  }
}

export class ThreadInputConflictError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "ThreadInputConflictError";
  }
}

async function assertOwnedScope(client: SqlClient, scope: ThreadInputScope): Promise<void> {
  const result = await client.query<InputRow>(ASSERT_SCOPE_SQL, [scope.sessionId, scope.userId, scope.threadId, scope.workspaceId]);
  if (!result.rows[0]) throw new ThreadInputConflictError("Conversation, thread, or workspace scope does not match", "thread_scope_conflict");
}

async function lockState(client: SqlClient, scope: ThreadInputScope): Promise<{ revision: number; paused: boolean }> {
  const result = await client.query<InputRow>(LOCK_STATE_SQL, [scope.sessionId, scope.threadId, scope.workspaceId]);
  const row = requiredRow(result.rows[0]);
  return { revision: requiredNumber(row.revision, "revision"), paused: row.paused === true };
}

async function incrementRevision(client: SqlClient, sessionId: string): Promise<number> {
  const result = await client.query<InputRow>(INCREMENT_REVISION_SQL, [sessionId]);
  return requiredNumber(result.rows[0]?.revision, "revision");
}

async function readOwnedInput(client: SqlClient, scope: ThreadInputScope, itemId: string): Promise<StoredThreadInput | null> {
  const result = await client.query<InputRow>(READ_OWNED_INPUT_SQL, [scope.sessionId, scope.userId, scope.threadId, scope.workspaceId, itemId]);
  return result.rows[0] ? mapInput(result.rows[0]) : null;
}

function mapInput(row: InputRow): StoredThreadInput {
  const content = asRecord(row.content_json);
  return {
    itemId: requiredString(row.id, "id"),
    clientInputId: requiredString(row.client_input_id, "client_input_id"),
    order: requiredNumber(row.order_number, "order_number"),
    version: requiredNumber(row.version, "version"),
    state: row.state ?? "pending",
    delivery: row.delivery ?? "queue",
    targetTurnId: row.target_turn_id ? TurnIdSchema.parse(row.target_turn_id) : null,
    targetRunAttemptId: row.target_run_attempt_id
      ? RunAttemptIdSchema.parse(row.target_run_attempt_id)
      : null,
    text: typeof content.text === "string" ? content.text : "",
    mediaRefs: Array.isArray(content.mediaRefs) ? content.mediaRefs as StoredThreadInput["mediaRefs"] : [],
    configuration: asRecord(row.configuration_json) as StoredThreadInput["configuration"],
    receipt: row.receipt_json == null ? null : ThreadInputReceiptSchema.parse(row.receipt_json),
    sessionId: requiredString(row.session_id, "session_id"),
    userId: requiredString(row.user_id, "user_id"),
    threadId: requiredString(row.thread_id, "thread_id"),
    workspaceId: requiredString(row.workspace_id, "workspace_id"),
    fingerprint: requiredString(row.fingerprint, "fingerprint"),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { return asRecord(JSON.parse(value)); } catch { return {}; }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredRow(row: InputRow | undefined): InputRow {
  if (!row) throw new Error("Thread input write returned no row");
  return row;
}
function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Missing ${name}`);
  return value;
}
function requiredNumber(value: unknown, name: string): number {
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number)) throw new Error(`Missing ${name}`);
  return number;
}

const ASSERT_SCOPE_SQL = `SELECT s.id FROM sessions s WHERE s.id = $1 AND s.user_id = $2 AND s.thread_id = $3 AND s.workspace_id = $4`;
const LOCK_STATE_SQL = `INSERT INTO thread_input_state (session_id, thread_id, workspace_id) VALUES ($1,$2,$3) ON CONFLICT (session_id) DO UPDATE SET updated_at = now() WHERE thread_input_state.thread_id = EXCLUDED.thread_id AND thread_input_state.workspace_id = EXCLUDED.workspace_id RETURNING revision, paused`;
const READ_STATE_SQL = `SELECT revision, paused, pause_reason FROM thread_input_state WHERE session_id = $1`;
const READ_ACTIVE_RUN_SQL = `SELECT active_run_id FROM sessions WHERE id = $1 AND user_id = $2 AND thread_id = $3 AND workspace_id = $4`;
const READ_LATEST_STARTED_SQL = `SELECT order_number, receipt_json FROM thread_inputs WHERE session_id = $1 AND receipt_json->>'status' = 'started' ORDER BY order_number DESC LIMIT 1`;
const READ_INPUTS_SQL = `SELECT * FROM thread_inputs WHERE session_id = $1 AND delivery IN ('queue','steer') AND state IN ('pending','consuming') ORDER BY order_number ASC`;
const READ_CLIENT_INPUT_SQL = `SELECT * FROM thread_inputs WHERE thread_id = $1 AND workspace_id = $2 AND client_input_id = $3 FOR UPDATE`;
const ALLOCATE_INPUT_ORDER_SQL = `UPDATE thread_input_state SET next_order = next_order + 1 WHERE session_id = $1 RETURNING next_order AS order_number`;
const INSERT_INPUT_SQL = `INSERT INTO thread_inputs (session_id,user_id,thread_id,workspace_id,client_input_id,fingerprint,delivery,target_turn_id,target_run_attempt_id,content_json,configuration_json,order_number) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12) RETURNING *`;
const INCREMENT_REVISION_SQL = `UPDATE thread_input_state SET revision = revision + 1, updated_at = now() WHERE session_id = $1 RETURNING revision`;
const READ_OWNED_INPUT_SQL = `SELECT * FROM thread_inputs WHERE session_id = $1 AND user_id = $2 AND thread_id = $3 AND workspace_id = $4 AND id = $5 FOR UPDATE`;
const UPDATE_INPUT_SQL = `UPDATE thread_inputs SET content_json = $4::jsonb, configuration_json = COALESCE($5::jsonb, configuration_json), version = version + 1, updated_at = now() WHERE session_id = $1 AND id = $2 AND version = $3 AND state = 'pending' RETURNING *`;
const CLAIM_QUEUED_INPUT_FOR_STEERING_SQL = `UPDATE thread_inputs SET delivery = 'steer', target_turn_id = $4, target_run_attempt_id = $5, state = 'consuming', version = version + 1, updated_at = now() WHERE session_id = $1 AND id = $2 AND version = $3 AND state = 'pending' AND delivery = 'queue' RETURNING *`;
const REMOVE_INPUT_SQL = `UPDATE thread_inputs SET state = 'cancelled', version = version + 1, updated_at = now() WHERE session_id = $1 AND id = $2 AND version = $3 AND state = 'pending' RETURNING *`;
const RECORD_CANCELLATION_RECEIPT_SQL = `UPDATE thread_inputs SET receipt_json = $3::jsonb WHERE session_id = $1 AND id = $2 RETURNING *`;
const SET_PAUSED_SQL = `UPDATE thread_input_state SET paused = $2, pause_reason = $3, revision = revision + CASE WHEN paused IS DISTINCT FROM $2 OR pause_reason IS DISTINCT FROM $3 THEN 1 ELSE 0 END, updated_at = now() WHERE session_id = $1 RETURNING revision`;
const RECORD_RECEIPT_SQL = `UPDATE thread_inputs SET state = $4, receipt_json = $5::jsonb, version = version + 1, updated_at = now(), consumed_at = CASE WHEN $4 IN ('consumed','cancelled') THEN now() ELSE consumed_at END WHERE session_id = $1 AND id = $2 AND version = $3 RETURNING *`;
