import type { SqlClient, SqlRow } from "../sql.js";
import { PostgresRunRepository } from "../runs/PostgresRunRepository.js";
import { PostgresTranscriptRepository } from "../sessions/PostgresTranscriptRepository.js";
import type {
  AdmitTurnWithPromptInput,
  ReserveTurnAdmissionInput,
  TurnAdmissionRecord,
  TurnAdmissionRepository,
} from "./types.js";

interface AdmissionRow extends SqlRow {
  task_id?: string | null;
  task_user_id?: string | null;
  task_workspace_id?: string | null;
  session_id?: string;
  client_message_id?: string;
  thread_id?: string;
  turn_id?: string;
  run_attempt_id?: string;
  run_id?: string;
  workspace_id?: string | null;
  revision_of_turn_id?: string | null;
  admission_state?: "reserved" | "admitted";
  execution_state?: "pending" | "running" | "recovery_required" | "settled";
  request_fingerprint?: string | null;
  admission_order?: number | string | null;
  created_at?: string | Date;
  admitted_at?: string | Date | null;
  owner_user_id?: string;
  session_workspace_id?: string | null;
  run_user_id?: string | null;
  run_session_id?: string | null;
  run_workspace_id?: string | null;
  terminal_turn_id?: string | null;
}

export class TurnAdmissionConflictError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "TurnAdmissionConflictError";
  }
}

function assertOwnedTaskScope(
  session: AdmissionRow,
  userId: string,
  expectedTaskId: string | null,
): void {
  if (expectedTaskId && session.task_id !== expectedTaskId) {
    throw new TurnAdmissionConflictError("Conversation task does not match", "task_scope_conflict");
  }
  if (session.task_id && !session.task_user_id) {
    throw new TurnAdmissionConflictError("Conversation task was not found", "task_scope_conflict");
  }
  if (session.task_user_id && session.task_user_id !== userId) {
    throw new TurnAdmissionConflictError("Conversation task belongs to a different owner", "task_scope_conflict");
  }
  if (
    session.session_workspace_id != null &&
    session.task_workspace_id != null &&
    session.session_workspace_id !== session.task_workspace_id
  ) {
    throw new TurnAdmissionConflictError("Conversation session and task workspaces do not match", "workspace_conflict");
  }
}

function resolveEstablishedWorkspace(session: AdmissionRow): string | null {
  return session.session_workspace_id ?? session.task_workspace_id ?? null;
}

export class PostgresTurnAdmissionRepository implements TurnAdmissionRepository {
  constructor(private readonly client: SqlClient) {}

  async reserve(input: ReserveTurnAdmissionInput): Promise<TurnAdmissionRecord> {
    return await this.client.transaction(async (tx) => {
      const sessionResult = await tx.query<AdmissionRow>(LOCK_OWNED_SESSION_SQL, [
        input.sessionId,
        input.userId,
        input.runId,
      ]);
      const session = sessionResult.rows[0];
      if (!session) {
        throw new TurnAdmissionConflictError("Owned conversation not found", "session_not_found");
      }
      assertOwnedTaskScope(session, input.userId, session.task_id ?? null);
      const establishedWorkspace = resolveEstablishedWorkspace(session);
      if (establishedWorkspace !== null && establishedWorkspace !== input.workspaceId) {
        throw new TurnAdmissionConflictError("Conversation workspace does not match", "workspace_conflict");
      }
      if (
        session.run_user_id &&
        (session.run_user_id !== input.userId ||
          session.run_session_id !== input.sessionId ||
          (session.run_workspace_id ?? null) !== input.workspaceId &&
          session.run_workspace_id !== null)
      ) {
        throw new TurnAdmissionConflictError("Run belongs to a different owner, conversation, or workspace", "run_scope_conflict");
      }

      const establishedThreadId = session.thread_id;
      const canonicalThreadId = establishedThreadId ?? input.threadId;
      const canonicalWorkspaceId = establishedWorkspace ?? input.workspaceId;
      if (!establishedThreadId || session.session_workspace_id == null) {
        await tx.query(BIND_SESSION_THREAD_SQL, [input.sessionId, input.userId, input.threadId, canonicalWorkspaceId]);
      }
      if (session.session_workspace_id == null && canonicalWorkspaceId !== null) {
        await tx.query(BIND_SESSION_WORKSPACE_SQL, [input.sessionId, input.userId, canonicalWorkspaceId]);
      }
      if (session.run_user_id === input.userId && session.run_session_id === input.sessionId && session.run_workspace_id == null && input.workspaceId !== null) {
        await tx.query(BIND_OWNED_RUN_WORKSPACE_SQL, [input.runId, input.userId, input.sessionId, input.workspaceId]);
      }

      const existingResult = await tx.query<AdmissionRow>(READ_SESSION_CLIENT_SQL, [
        input.sessionId,
        input.clientMessageId,
      ]);
      const existing = existingResult.rows[0];
      if (existing) {
        const record = mapAdmission(existing);
        if (
          record.runId !== input.runId ||
          record.workspaceId !== input.workspaceId ||
          record.revisionOfTurnId !== (input.revisionOfTurnId ?? null) ||
          record.turnId !== input.turnId
        ) {
          throw new TurnAdmissionConflictError("Client message is already reserved for a different turn identity", "client_message_conflict");
        }
        return record;
      }

      if (input.revisionOfTurnId) {
        const revisionResult = await tx.query<AdmissionRow>(READ_REVISION_TURN_SQL, [
          input.sessionId,
          input.revisionOfTurnId,
        ]);
        if (!revisionResult.rows[0]) {
          throw new TurnAdmissionConflictError("Revision target is not an owned admitted turn", "revision_target_not_found");
        }
        if (!revisionResult.rows[0].terminal_turn_id) {
          throw new TurnAdmissionConflictError("Revision target is not terminal", "revision_target_not_terminal");
        }
      }

      const inserted = await tx.query<AdmissionRow>(INSERT_RESERVED_SQL, [
        input.sessionId,
        input.clientMessageId,
        canonicalThreadId,
        input.turnId,
        input.runAttemptId,
        input.runId,
        input.workspaceId,
        input.revisionOfTurnId ?? null,
      ]);
      return mapAdmission(requiredRow(inserted.rows[0]));
    });
  }

  async admitWithPrompt(
    input: AdmitTurnWithPromptInput,
  ): Promise<{ admission: TurnAdmissionRecord; promptMessageId: string; run: import("../runs/types.js").RunRecord }> {
    return await this.client.transaction(async (tx) => {
      const sessionResult = await tx.query<AdmissionRow>(LOCK_OWNED_SESSION_SQL, [
        input.sessionId,
        input.userId,
        input.runId,
      ]);
      const session = sessionResult.rows[0];
      if (!session) throw new TurnAdmissionConflictError("Owned conversation not found", "session_not_found");
      assertOwnedTaskScope(session, input.userId, input.taskId);
      const establishedWorkspace = resolveEstablishedWorkspace(session);
      if (establishedWorkspace !== input.workspaceId) {
        throw new TurnAdmissionConflictError("Conversation workspace does not match", "workspace_conflict");
      }
      const existingResult = await tx.query<AdmissionRow>(LOCK_ADMISSION_SQL, [
        input.sessionId,
        input.clientMessageId,
      ]);
      const existingRow = existingResult.rows[0];
      if (!existingRow) throw new TurnAdmissionConflictError("Reserved turn admission not found", "admission_not_found");
      const existing = mapAdmission(existingRow);
      if (
        existing.turnId !== input.turnId ||
        existing.runAttemptId !== input.runAttemptId ||
        existing.runId !== input.runId ||
        existing.userId !== input.userId ||
        existing.workspaceId !== input.workspaceId
      ) {
        throw new TurnAdmissionConflictError("Turn admission identity does not match", "identity_conflict");
      }
      if (existing.state === "admitted") {
        if (existing.requestFingerprint !== input.requestFingerprint) {
          throw new TurnAdmissionConflictError("Admitted prompt fingerprint does not match", "fingerprint_conflict");
        }
        const message = await tx.query<AdmissionRow>(READ_PROMPT_BY_DEDUPE_SQL, [input.sessionId, input.promptMessage.dedupeKey]);
        const promptMessageId = message.rows[0]?.prompt_message_id;
        if (typeof promptMessageId !== "string") {
          throw new TurnAdmissionConflictError("Admitted prompt projection is missing and needs recovery", "prompt_projection_missing");
        }
        const run = await new PostgresRunRepository(tx).getRun(input.runId, input.userId);
        if (!run) throw new TurnAdmissionConflictError("Admitted run projection is missing", "run_projection_missing");
        return { admission: existing, promptMessageId, run };
      }
      if (existing.revisionOfTurnId) {
        const revisionResult = await tx.query<AdmissionRow>(READ_REVISION_TURN_SQL, [
          input.sessionId,
          existing.revisionOfTurnId,
        ]);
        if (!revisionResult.rows[0]?.terminal_turn_id) {
          throw new TurnAdmissionConflictError("Revision target is no longer the current terminal turn", "revision_target_not_current");
        }
      }

      const orderResult = await tx.query<AdmissionRow>(ALLOCATE_ADMISSION_ORDER_SQL, [input.sessionId]);
      const admissionOrderValue = orderResult.rows[0]?.admission_order;
      if (admissionOrderValue === undefined || admissionOrderValue === null) {
        throw new TurnAdmissionConflictError("Unable to allocate admission order", "admission_order_unavailable");
      }
      const admissionOrder = Number(admissionOrderValue);

      const run = await new PostgresRunRepository(tx).ensureRun({
        id: input.runId,
        userId: input.userId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        taskId: input.taskId,
        status: input.runStatus ?? "running",
        mode: input.mode,
        providerId: input.providerId,
        modelId: input.modelId,
        branch: input.branch,
      });
      const prompt = await new PostgresTranscriptRepository(tx, undefined, true).appendMessage({
        sessionId: input.sessionId,
        userId: input.userId,
        workspaceId: input.workspaceId,
        threadId: existing.threadId,
        taskId: input.taskId,
        activeRunId: input.runId,
        mode: input.mode,
        status: "running",
        runId: input.runId,
        role: input.promptMessage.role,
        clientMessageId: input.promptMessage.clientMessageId,
        dedupeKey: input.promptMessage.dedupeKey,
        parts: input.promptMessage.parts,
      });
      await tx.query(SET_CURRENT_SESSION_TURN_SQL, [input.sessionId, input.runId, input.turnId]);
      const updated = await tx.query<AdmissionRow>(PROMOTE_ADMISSION_SQL, [
        input.sessionId,
        input.clientMessageId,
        input.requestFingerprint,
        admissionOrder,
      ]);
      return { admission: mapAdmission(requiredRow(updated.rows[0])), promptMessageId: prompt.id, run };
    });
  }

  async getByTurnId(turnId: string): Promise<TurnAdmissionRecord | null> {
    const result = await this.client.query<AdmissionRow>(READ_BY_TURN_SQL, [turnId]);
    return result.rows[0] ? mapAdmission(result.rows[0]) : null;
  }

  async getBySessionAndClientMessage(
    sessionId: string,
    clientMessageId: string,
  ): Promise<TurnAdmissionRecord | null> {
    const result = await this.client.query<AdmissionRow>(READ_SESSION_CLIENT_SQL, [sessionId, clientMessageId]);
    return result.rows[0] ? mapAdmission(result.rows[0]) : null;
  }

  async getBySessionAndRunId(
    sessionId: string,
    runId: string,
  ): Promise<TurnAdmissionRecord | null> {
    const result = await this.client.query<AdmissionRow>(READ_SESSION_RUN_SQL, [sessionId, runId]);
    return result.rows[0] ? mapAdmission(result.rows[0]) : null;
  }

  async claimExecution(input: {
    turnId: string;
    runAttemptId: string;
    runId: string;
    sessionId: string;
    userId: string;
    workspaceId: string;
    threadId: string;
    claimId: string;
  }): Promise<{ status: "claimed" | "already_claimed" | "recovery_required" | "settled" | "conflict"; admission: TurnAdmissionRecord | null }> {
    return await this.client.transaction(async (tx) => {
      const result = await tx.query<AdmissionRow>(LOCK_ADMISSION_BY_TURN_SQL, [input.turnId]);
      const row = result.rows[0];
      if (!row) return { status: "conflict", admission: null };
      const admission = mapAdmission(row);
      if (
        admission.state !== "admitted" ||
        admission.turnId !== input.turnId ||
        admission.runAttemptId !== input.runAttemptId ||
        admission.runId !== input.runId ||
        admission.sessionId !== input.sessionId ||
        admission.userId !== input.userId ||
        admission.workspaceId !== input.workspaceId ||
        admission.threadId !== input.threadId
      ) return { status: "conflict", admission };
      if (admission.executionState === "settled") return { status: "settled", admission };
      if (admission.executionState !== "pending") {
        return { status: admission.executionState === "recovery_required" ? "recovery_required" : "already_claimed", admission };
      }
      const claimed = await tx.query<AdmissionRow>(CLAIM_EXECUTION_SQL, [
        input.turnId,
        input.claimId,
      ]);
      return { status: "claimed", admission: mapAdmission(requiredRow(claimed.rows[0])) };
    });
  }

  async markRecoveryRequired(input: { turnId: string; claimId: string }): Promise<boolean> {
    const result = await this.client.query<AdmissionRow>(MARK_RECOVERY_REQUIRED_SQL, [input.turnId, input.claimId]);
    return result.rows.length > 0;
  }
}

function mapAdmission(row: AdmissionRow): TurnAdmissionRecord {
  return {
    userId: requiredString(row.owner_user_id, "owner_user_id"),
    sessionId: requiredString(row.session_id, "session_id"),
    clientMessageId: requiredString(row.client_message_id, "client_message_id"),
    threadId: requiredString(row.thread_id, "thread_id"),
    turnId: requiredString(row.turn_id, "turn_id"),
    runAttemptId: requiredString(row.run_attempt_id, "run_attempt_id"),
    runId: requiredString(row.run_id, "run_id"),
    workspaceId: row.workspace_id ?? null,
    revisionOfTurnId: row.revision_of_turn_id ?? null,
    state: row.admission_state ?? "reserved",
    executionState: row.execution_state ?? "pending",
    requestFingerprint: row.request_fingerprint ?? null,
    admissionOrder: row.admission_order == null ? null : Number(row.admission_order),
    createdAt: iso(row.created_at),
    admittedAt: row.admitted_at ? iso(row.admitted_at) : null,
  };
}

function requiredRow(row: AdmissionRow | undefined): AdmissionRow {
  if (!row) throw new Error("Turn admission write returned no row");
  return row;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Missing ${field}`);
  return value;
}

function iso(value: string | Date | undefined): string {
  if (!value) throw new Error("Missing admission timestamp");
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

const LOCK_OWNED_SESSION_SQL = `SELECT s.task_id, s.thread_id, s.workspace_id AS session_workspace_id, t.user_id AS task_user_id, t.workspace_id AS task_workspace_id, r.user_id AS run_user_id, r.session_id AS run_session_id, r.workspace_id AS run_workspace_id FROM sessions s LEFT JOIN tasks t ON t.id = s.task_id LEFT JOIN runs r ON r.id = $3 WHERE s.id = $1 AND s.user_id = $2 FOR UPDATE OF s`;
const BIND_SESSION_THREAD_SQL = `UPDATE sessions SET thread_id = COALESCE(thread_id,$3), workspace_id = COALESCE(workspace_id,$4), thread_binding_source = COALESCE(thread_binding_source,'runtime_admission'), updated_at = now() WHERE id = $1 AND user_id = $2 AND (thread_id IS NULL OR thread_id = $3) AND (workspace_id IS NULL OR workspace_id IS NOT DISTINCT FROM $4)`;
const BIND_SESSION_WORKSPACE_SQL = `UPDATE sessions SET workspace_id = $3, updated_at = now() WHERE id = $1 AND user_id = $2 AND workspace_id IS NULL`;
const BIND_OWNED_RUN_WORKSPACE_SQL = `UPDATE runs SET workspace_id = $4, updated_at = now() WHERE id = $1 AND user_id = $2 AND session_id = $3 AND workspace_id IS NULL`;
const READ_SESSION_CLIENT_SQL = `SELECT a.*, s.user_id AS owner_user_id FROM canonical_turn_admissions a JOIN sessions s ON s.id = a.session_id WHERE a.session_id = $1 AND a.client_message_id = $2`;
const READ_REVISION_TURN_SQL = `SELECT a.turn_id, terminal.turn_id AS terminal_turn_id FROM canonical_turn_admissions a JOIN sessions s ON s.id = a.session_id LEFT JOIN LATERAL (SELECT turn_id FROM canonical_lifecycle_events e WHERE e.turn_id = a.turn_id AND e.event_type IN ('turn.completed','turn.failed','turn.interrupted') ORDER BY e.sequence DESC LIMIT 1) terminal ON TRUE WHERE a.session_id = $1 AND a.turn_id = $2 AND a.admission_state = 'admitted' AND s.current_turn_id = a.turn_id AND NOT EXISTS (SELECT 1 FROM canonical_turn_admissions child WHERE child.session_id = a.session_id AND child.revision_of_turn_id = a.turn_id AND child.admission_state = 'admitted')`;
const INSERT_RESERVED_SQL = `INSERT INTO canonical_turn_admissions (session_id, client_message_id, thread_id, turn_id, run_attempt_id, run_id, workspace_id, revision_of_turn_id, admission_state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'reserved') RETURNING *, (SELECT user_id FROM sessions WHERE id = $1) AS owner_user_id`;
const LOCK_ADMISSION_SQL = `SELECT a.*, s.user_id AS owner_user_id FROM canonical_turn_admissions a JOIN sessions s ON s.id = a.session_id WHERE a.session_id = $1 AND a.client_message_id = $2 FOR UPDATE OF a`;
const PROMOTE_ADMISSION_SQL = `UPDATE canonical_turn_admissions a SET admission_state = 'admitted', execution_state = 'pending', request_fingerprint = $3, admission_order = $4, admitted_at = now() WHERE a.session_id = $1 AND a.client_message_id = $2 AND a.admission_state = 'reserved' RETURNING a.*, (SELECT user_id FROM sessions WHERE id = a.session_id) AS owner_user_id`;
const ALLOCATE_ADMISSION_ORDER_SQL = `UPDATE sessions SET admission_sequence = admission_sequence + 1 WHERE id = $1 RETURNING admission_sequence AS admission_order`;
const READ_BY_TURN_SQL = `SELECT a.*, s.user_id AS owner_user_id FROM canonical_turn_admissions a JOIN sessions s ON s.id = a.session_id WHERE a.turn_id = $1`;
const READ_SESSION_RUN_SQL = `SELECT a.*, s.user_id AS owner_user_id FROM canonical_turn_admissions a JOIN sessions s ON s.id = a.session_id WHERE a.session_id = $1 AND a.run_id = $2 ORDER BY a.admission_order DESC NULLS LAST, a.created_at DESC LIMIT 1`;
const READ_PROMPT_BY_DEDUPE_SQL = `SELECT id AS prompt_message_id FROM messages WHERE session_id = $1 AND dedupe_key = $2`;
const LOCK_ADMISSION_BY_TURN_SQL = `SELECT a.*, s.user_id AS owner_user_id FROM canonical_turn_admissions a JOIN sessions s ON s.id = a.session_id WHERE a.turn_id = $1 FOR UPDATE OF a`;
const CLAIM_EXECUTION_SQL = `UPDATE canonical_turn_admissions SET execution_state = 'running', execution_claim_id = $2, execution_claimed_at = now() WHERE turn_id = $1 AND admission_state = 'admitted' AND execution_state = 'pending' RETURNING *, (SELECT user_id FROM sessions WHERE id = canonical_turn_admissions.session_id) AS owner_user_id`;
const MARK_RECOVERY_REQUIRED_SQL = `UPDATE canonical_turn_admissions SET execution_state = 'recovery_required' WHERE turn_id = $1 AND execution_claim_id = $2 AND execution_state = 'running' RETURNING turn_id`;
const SET_CURRENT_SESSION_TURN_SQL = `UPDATE sessions SET current_turn_id = $3, updated_at = now() WHERE id = $1 AND active_run_id = $2`;
