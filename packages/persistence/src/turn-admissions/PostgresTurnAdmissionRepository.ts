import type { SqlClient, SqlRow } from "../sql.js";
import { PostgresRunRepository } from "../runs/PostgresRunRepository.js";
import { PostgresTranscriptRepository } from "../sessions/PostgresTranscriptRepository.js";
import type {
  AdmitContinuationInput,
  AdmitTurnWithPromptInput,
  InterruptedTurnTarget,
  InterruptedTurnTargetInput,
  ReserveTurnAdmissionInput,
  ReserveQueuedStartInput,
  ReserveQueuedStartResult,
  TurnAdmissionRecord,
  TurnAdmissionRepository,
} from "./types.js";
import {
  ThreadInputQueueItemSchema,
  userIdFromExternalId,
} from "@repo/platform-protocol";

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
  continuation_of_turn_id?: string | null;
  original_prompt_id?: string | null;
  continuation_terminal_sequence?: number | string | null;
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
  current_turn_id?: string | null;
  active_run_id?: string | null;
  revision?: number | string;
  paused?: boolean;
  id?: string;
  user_id?: string;
  content_json?: unknown;
  configuration_json?: unknown;
  version?: number | string;
  state?: string;
  delivery?: string;
  fingerprint?: string;
  client_input_id?: string;
  order_number?: number | string;
  receipt_json?: unknown;
  payload_json?: unknown;
  event_json?: unknown;
  prompt_id?: string;
  prompt_client_message_id?: string | null;
  prompt_parts?: unknown;
  source_run_id?: string;
  prompt_text?: string;
  terminal_event_json?: unknown;
  resume_artifact_event_json?: unknown;
  canonical_prompt_id?: string;
  snapshot_event_json?: unknown;
  prompt_message_id?: string;
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
          record.continuationOfTurnId !== (input.continuationOfTurnId ?? null) ||
          record.originalPromptId !== (input.originalPromptId ?? null) ||
          record.continuationTerminalSequence !== (input.continuationTerminalSequence ?? null) ||
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

      const hasContinuation = Boolean(
        input.continuationOfTurnId || input.originalPromptId || input.continuationTerminalSequence != null,
      );
      if (hasContinuation) {
        if (
          !input.continuationOfTurnId ||
          !input.originalPromptId ||
          input.continuationTerminalSequence == null
        ) {
          throw new TurnAdmissionConflictError(
            "Continuation turn, root prompt, and terminal sequence must be supplied together",
            "continuation_identity_incomplete",
          );
        }
        const continuation = await tx.query<AdmissionRow>(READ_CONTINUATION_TARGET_SQL, [
          input.sessionId,
          input.continuationOfTurnId,
          input.continuationTerminalSequence,
          input.originalPromptId,
        ]);
        if (!continuation.rows[0]) {
          throw new TurnAdmissionConflictError(
            "Resume target is no longer the latest interrupted turn or its original prompt does not match",
            "continuation_target_conflict",
          );
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
        input.continuationOfTurnId ?? null,
        input.originalPromptId ?? null,
        input.continuationTerminalSequence ?? null,
      ]);
      return mapAdmission(requiredRow(inserted.rows[0]));
    });
  }

  async reserveQueuedStart(input: ReserveQueuedStartInput): Promise<ReserveQueuedStartResult> {
    return await this.client.transaction(async (tx) => {
      const clientMessageId = `thread-input:${input.itemId}`;
      const dedupeKey = clientMessageId;
      const sessionResult = await tx.query<AdmissionRow>(LOCK_OWNED_SESSION_SQL, [
        input.sessionId,
        input.userId,
        input.runId,
      ]);
      const session = sessionResult.rows[0];
      if (!session || session.thread_id !== input.threadId || resolveEstablishedWorkspace(session) !== input.workspaceId) {
        throw new TurnAdmissionConflictError("Conversation, thread, or workspace scope does not match", "thread_scope_conflict");
      }
      assertOwnedTaskScope(session, input.userId, input.taskId);
      const stateResult = await tx.query<AdmissionRow>(LOCK_THREAD_INPUT_STATE_SQL, [
        input.sessionId,
        input.threadId,
        input.workspaceId,
      ]);
      const state = stateResult.rows[0];
      if (!state) throw new TurnAdmissionConflictError("Thread input state was not found", "thread_scope_conflict");
      const currentRevision = numberValue(state.revision, "thread_input_revision");
      const priorResult = await tx.query<AdmissionRow>(READ_SESSION_CLIENT_SQL, [input.sessionId, clientMessageId]);
      const prior = priorResult.rows[0];
      if (prior) {
        const admission = mapAdmission(prior);
        assertSameAdmissionReservation(admission, input, clientMessageId);
        if (admission.state !== "admitted" || admission.requestFingerprint !== input.requestFingerprint) {
          throw new TurnAdmissionConflictError("Queued input admission is incomplete or has a different fingerprint", "fingerprint_conflict");
        }
        const itemResult = await tx.query<AdmissionRow>(READ_QUEUED_START_SQL, [
          input.sessionId, input.userId, input.threadId, input.workspaceId, input.itemId,
        ]);
        const item = itemResult.rows[0] ? mapQueuedStart(itemResult.rows[0]) : null;
        const promptResult = await tx.query<AdmissionRow>(READ_PROMPT_BY_DEDUPE_SQL, [input.sessionId, dedupeKey]);
        const promptMessageId = promptResult.rows[0]?.prompt_message_id;
        if (!item || typeof promptMessageId !== "string") throw new TurnAdmissionConflictError("Admitted queue projection is missing and needs recovery", "prompt_projection_missing");
        const run = await new PostgresRunRepository(tx).getRun(input.runId, input.userId);
        if (!run) throw new TurnAdmissionConflictError("Admitted run projection is missing", "run_projection_missing");
        return {
          status: "admitted",
          admission,
          revision: currentRevision,
          acceptedInput: item ? { inputId: item.itemId, clientInputId: item.clientInputId } : null,
          promptMessageId,
          run,
          item,
        };
      }
      if (currentRevision !== input.expectedRevision) {
        const currentItemResult = await tx.query<AdmissionRow>(READ_QUEUED_START_SQL, [
          input.sessionId, input.userId, input.threadId, input.workspaceId, input.itemId,
        ]);
        const currentItem = currentItemResult.rows[0] ? mapQueuedStart(currentItemResult.rows[0]) : null;
        return { status: "conflict", admission: null, revision: currentRevision, acceptedInput: null, promptMessageId: null, run: null, item: currentItem, code: "queue_revision_conflict" };
      }
      if (session.active_run_id) {
        return { status: "conflict", admission: null, revision: currentRevision, acceptedInput: null, promptMessageId: null, run: null, item: null, code: "turn_not_idle" };
      }
      if (input.explicitStart !== true) {
        const completed = await tx.query<AdmissionRow>(READ_CURRENT_COMPLETED_TURN_SQL, [input.sessionId]);
        if (!completed.rows[0]) {
          return { status: "conflict", admission: null, revision: currentRevision, acceptedInput: null, promptMessageId: null, run: null, item: null, code: "turn_not_idle" };
        }
      }
      if (state.paused === true && input.explicitStart !== true) {
        const currentItemResult = await tx.query<AdmissionRow>(READ_QUEUED_START_SQL, [
          input.sessionId, input.userId, input.threadId, input.workspaceId, input.itemId,
        ]);
        const currentItem = currentItemResult.rows[0] ? mapQueuedStart(currentItemResult.rows[0]) : null;
        return { status: "conflict", admission: null, revision: currentRevision, acceptedInput: null, promptMessageId: null, run: null, item: currentItem, code: "queue_paused" };
      }
      const itemResult = await tx.query<AdmissionRow>(READ_QUEUED_START_FOR_UPDATE_SQL, [
        input.sessionId, input.userId, input.threadId, input.workspaceId, input.itemId,
      ]);
      const queued = itemResult.rows[0];
      if (!queued || queued.delivery !== "queue" || queued.state !== "pending" || numberValue(queued.version, "version") !== input.expectedVersion) {
        const code = queued && queued.state !== "pending" ? "queue_item_consumed" : "queue_item_changed";
        const item = queued ? mapQueuedStart(queued) : null;
        return { status: "conflict", admission: null, revision: currentRevision, acceptedInput: null, promptMessageId: null, run: null, item, code };
      }
      const startedReceipt = {
        status: "started",
        itemId: input.itemId,
        turnId: input.turnId,
        runAttemptId: input.runAttemptId,
        runId: input.runId,
      };
      const claimed = await tx.query<AdmissionRow>(CLAIM_QUEUED_START_SQL, [
        input.sessionId,
        input.itemId,
        input.expectedVersion,
        JSON.stringify(startedReceipt),
      ]);
      if (!claimed.rows[0]) {
        return { status: "conflict", admission: null, revision: currentRevision, acceptedInput: null, promptMessageId: null, run: null, item: null, code: "queue_item_changed" };
      }
      if (input.explicitStart === true && state.paused === true) {
        await tx.query(CLEAR_THREAD_INPUT_PAUSE_SQL, [input.sessionId]);
      }
      const inserted = await tx.query<AdmissionRow>(INSERT_RESERVED_SQL, [
        input.sessionId,
        clientMessageId,
        input.threadId,
        input.turnId,
        input.runAttemptId,
        input.runId,
        input.workspaceId,
        null,
        null,
        null,
        null,
      ]);
      const orderResult = await tx.query<AdmissionRow>(ALLOCATE_ADMISSION_ORDER_SQL, [input.sessionId]);
      const admissionOrder = numberValue(orderResult.rows[0]?.admission_order, "admission_order");
      const run = await new PostgresRunRepository(tx).ensureRun({
        id: input.runId,
        userId: input.userId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        taskId: input.taskId,
        status: "running",
        mode: input.mode,
        providerId: input.providerId,
        modelId: input.modelId,
        branch: input.branch,
      });
      const prompt = await new PostgresTranscriptRepository(tx, undefined, true).appendMessage({
        sessionId: input.sessionId,
        userId: input.userId,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        taskId: input.taskId,
        activeRunId: input.runId,
        mode: input.mode,
        status: "running",
        runId: input.runId,
        role: "user",
        clientMessageId,
        dedupeKey,
        parts: input.promptMessage.parts,
      });
      await tx.query(BIND_PROMPT_TURN_IDENTITY_SQL, [input.sessionId, prompt.id, input.turnId, input.runAttemptId]);
      const activated = await tx.query<AdmissionRow>(ACTIVATE_QUEUED_SESSION_SQL, [input.sessionId, input.runId, input.turnId]);
      if (!activated.rows[0]) throw new TurnAdmissionConflictError("Conversation became active before queued admission", "session_active_conflict");
      const promoted = await tx.query<AdmissionRow>(PROMOTE_ADMISSION_SQL, [input.sessionId, clientMessageId, input.requestFingerprint, admissionOrder]);
      const revisionResult = await tx.query<AdmissionRow>(READ_THREAD_INPUT_REVISION_SQL, [input.sessionId]);
      const item = mapQueuedStart(claimed.rows[0]);
      return {
        status: "admitted",
        admission: mapAdmission(requiredRow(promoted.rows[0])),
        revision: numberValue(revisionResult.rows[0]?.revision, "thread_input_revision"),
        acceptedInput: { inputId: item.itemId, clientInputId: item.clientInputId },
        promptMessageId: prompt.id,
        run,
        item,
      };
    });
  }

  async admitContinuation(input: AdmitContinuationInput): Promise<{ admission: TurnAdmissionRecord; run: import("../runs/types.js").RunRecord }> {
    return await this.client.transaction(async (tx) => {
      const sessionResult = await tx.query<AdmissionRow>(LOCK_OWNED_SESSION_SQL, [input.sessionId, input.userId, input.runId]);
      const session = sessionResult.rows[0];
      if (!session) throw new TurnAdmissionConflictError("Owned conversation not found", "session_not_found");
      assertOwnedTaskScope(session, input.userId, input.taskId);
      if (resolveEstablishedWorkspace(session) !== input.workspaceId) {
        throw new TurnAdmissionConflictError("Conversation workspace does not match", "workspace_conflict");
      }
      if (session.thread_id !== input.threadId) {
        throw new TurnAdmissionConflictError("Conversation thread does not match", "thread_scope_conflict");
      }
      const continuation = await tx.query<AdmissionRow>(READ_CONTINUATION_TARGET_FOR_COMMAND_SQL, [
        input.sessionId,
        input.continuationOfTurnId,
        input.continuationTerminalSequence,
        input.originalPromptId,
        input.clientMessageId,
      ]);
      if (!continuation.rows[0]) {
        throw new TurnAdmissionConflictError("Resume target is no longer the latest interrupted turn", "continuation_target_conflict");
      }
      const existingResult = await tx.query<AdmissionRow>(LOCK_ADMISSION_SQL, [input.sessionId, input.clientMessageId]);
      let existingRow = existingResult.rows[0];
      if (!existingRow) {
        const reserved = await tx.query<AdmissionRow>(INSERT_RESERVED_SQL, [
          input.sessionId,
          input.clientMessageId,
          input.threadId,
          input.turnId,
          input.runAttemptId,
          input.runId,
          input.workspaceId,
          null,
          input.continuationOfTurnId,
          input.originalPromptId,
          input.continuationTerminalSequence,
        ]);
        existingRow = requiredRow(reserved.rows[0]);
      }
      const existing = mapAdmission(existingRow);
      if (
        existing.turnId !== input.turnId || existing.runAttemptId !== input.runAttemptId || existing.runId !== input.runId ||
        existing.userId !== input.userId || existing.workspaceId !== input.workspaceId ||
        existing.continuationOfTurnId !== input.continuationOfTurnId || existing.originalPromptId !== input.originalPromptId ||
        existing.continuationTerminalSequence !== input.continuationTerminalSequence
      ) throw new TurnAdmissionConflictError("Continuation admission identity does not match", "identity_conflict");
      if (existing.state === "admitted") {
        if (existing.requestFingerprint !== input.requestFingerprint) throw new TurnAdmissionConflictError("Admitted continuation fingerprint does not match", "fingerprint_conflict");
        const run = await new PostgresRunRepository(tx).getRun(input.runId, input.userId);
        if (!run) throw new TurnAdmissionConflictError("Admitted run projection is missing", "run_projection_missing");
        return { admission: existing, run };
      }
      const orderResult = await tx.query<AdmissionRow>(ALLOCATE_ADMISSION_ORDER_SQL, [input.sessionId]);
      const admissionOrder = numberValue(orderResult.rows[0]?.admission_order, "admission_order");
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
      const activated = await tx.query<AdmissionRow>(ACTIVATE_CONTINUATION_SESSION_SQL, [input.sessionId, input.runId, input.turnId, input.continuationOfTurnId]);
      if (!activated.rows[0]) throw new TurnAdmissionConflictError("Conversation has an active or different current turn", "continuation_target_conflict");
      const updated = await tx.query<AdmissionRow>(PROMOTE_ADMISSION_SQL, [input.sessionId, input.clientMessageId, input.requestFingerprint, admissionOrder]);
      return { admission: mapAdmission(requiredRow(updated.rows[0])), run };
    });
  }

  async getInterruptedTarget(input: InterruptedTurnTargetInput): Promise<InterruptedTurnTarget | null> {
    const result = await this.client.query<AdmissionRow>(READ_INTERRUPTED_TARGET_SQL, [
      input.sessionId,
      input.userId,
      input.workspaceId,
      input.threadId,
      input.turnId,
      input.runAttemptId,
      input.terminalSequence,
      input.clientMessageId,
      userIdFromExternalId(input.userId),
    ]);
    const row = result.rows[0];
    if (!row) return null;
    const run = await new PostgresRunRepository(this.client).getRun(requiredString(row.source_run_id, "source_run_id"), input.userId);
    if (!run) return null;
    return {
      admission: mapAdmission(row),
      originalPromptId: requiredString(row.canonical_prompt_id, "canonical_prompt_id"),
      prompt: { text: requiredPossiblyEmptyString(row.prompt_text, "prompt_text"), parts: parseJsonArray(row.prompt_parts) as InterruptedTurnTarget["prompt"]["parts"] },
      run,
      terminalEvent: jsonValue(row.terminal_event_json),
      resumeArtifactEvent: jsonValue(row.resume_artifact_event_json),
      snapshotEvent: jsonValue(row.snapshot_event_json),
    };
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
      await tx.query(BIND_PROMPT_TURN_IDENTITY_SQL, [
        input.sessionId,
        prompt.id,
        input.turnId,
        input.runAttemptId,
      ]);
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
    continuationOfTurnId: row.continuation_of_turn_id ?? null,
    originalPromptId: row.original_prompt_id ?? null,
    continuationTerminalSequence: row.continuation_terminal_sequence == null
      ? null
      : Number(row.continuation_terminal_sequence),
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

function requiredPossiblyEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Missing ${field}`);
  return value;
}

function numberValue(value: unknown, field: string): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed)) throw new Error(`Missing ${field}`);
  return parsed;
}

function jsonValue(value: unknown): import("@repo/shared-types").JsonValue {
  if (typeof value === "string") {
    try { return JSON.parse(value) as import("@repo/shared-types").JsonValue; } catch { return null; }
  }
  return (value ?? null) as import("@repo/shared-types").JsonValue;
}

function parseJsonArray(value: unknown): unknown[] {
  const parsed = typeof value === "string" ? jsonValue(value) : value;
  return Array.isArray(parsed) ? parsed : [];
}

function assertSameAdmissionReservation(
  record: TurnAdmissionRecord,
  input: ReserveQueuedStartInput,
  clientMessageId: string,
): void {
  if (
    record.clientMessageId !== clientMessageId || record.turnId !== input.turnId ||
    record.runAttemptId !== input.runAttemptId || record.runId !== input.runId ||
    record.workspaceId !== input.workspaceId || record.threadId !== input.threadId ||
    record.revisionOfTurnId !== (input.revisionOfTurnId ?? null) ||
    record.continuationOfTurnId !== null || record.originalPromptId !== null ||
    record.continuationTerminalSequence !== null
  ) throw new TurnAdmissionConflictError("Queued input is already reserved for a different turn identity", "client_message_conflict");
}

function mapQueuedStart(row: AdmissionRow): NonNullable<ReserveQueuedStartResult["item"]> {
  const content = jsonValue(row.content_json);
  const contentRecord = typeof content === "object" && content !== null && !Array.isArray(content) ? content as Record<string, unknown> : {};
  const parsed = ThreadInputQueueItemSchema.parse({
    itemId: requiredString(row.id, "thread_input_id"),
    clientInputId: requiredString(row.client_input_id, "client_input_id"),
    order: numberValue(row.order_number, "thread_input_order"),
    version: numberValue(row.version, "thread_input_version"),
    state: row.state,
    delivery: row.delivery,
    targetTurnId: row.target_turn_id ?? null,
    targetRunAttemptId: row.target_run_attempt_id ?? null,
    text: typeof contentRecord.text === "string" ? contentRecord.text : "",
    mediaRefs: Array.isArray(contentRecord.mediaRefs) ? contentRecord.mediaRefs : [],
    configuration: jsonValue(row.configuration_json),
    receipt: row.receipt_json == null ? null : jsonValue(row.receipt_json),
  });
  return {
    itemId: parsed.itemId,
    clientInputId: parsed.clientInputId,
    version: parsed.version,
    text: parsed.text,
    mediaRefs: parsed.mediaRefs,
    configuration: parsed.configuration,
    receipt: parsed.receipt,
  };
}

function iso(value: string | Date | undefined): string {
  if (!value) throw new Error("Missing admission timestamp");
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

const LOCK_OWNED_SESSION_SQL = `SELECT s.task_id, s.thread_id, s.workspace_id AS session_workspace_id, s.current_turn_id, s.active_run_id, t.user_id AS task_user_id, t.workspace_id AS task_workspace_id, r.user_id AS run_user_id, r.session_id AS run_session_id, r.workspace_id AS run_workspace_id FROM sessions s LEFT JOIN tasks t ON t.id = s.task_id LEFT JOIN runs r ON r.id = $3 WHERE s.id = $1 AND s.user_id = $2 FOR UPDATE OF s`;
const BIND_SESSION_THREAD_SQL = `UPDATE sessions SET thread_id = COALESCE(thread_id,$3), workspace_id = COALESCE(workspace_id,$4), thread_binding_source = COALESCE(thread_binding_source,'runtime_admission'), updated_at = now() WHERE id = $1 AND user_id = $2 AND (thread_id IS NULL OR thread_id = $3) AND (workspace_id IS NULL OR workspace_id IS NOT DISTINCT FROM $4)`;
const BIND_SESSION_WORKSPACE_SQL = `UPDATE sessions SET workspace_id = $3, updated_at = now() WHERE id = $1 AND user_id = $2 AND workspace_id IS NULL`;
const BIND_OWNED_RUN_WORKSPACE_SQL = `UPDATE runs SET workspace_id = $4, updated_at = now() WHERE id = $1 AND user_id = $2 AND session_id = $3 AND workspace_id IS NULL`;
const READ_SESSION_CLIENT_SQL = `SELECT a.*, s.user_id AS owner_user_id FROM canonical_turn_admissions a JOIN sessions s ON s.id = a.session_id WHERE a.session_id = $1 AND a.client_message_id = $2`;
const READ_REVISION_TURN_SQL = `SELECT a.turn_id, terminal.turn_id AS terminal_turn_id FROM canonical_turn_admissions a JOIN sessions s ON s.id = a.session_id LEFT JOIN LATERAL (SELECT turn_id FROM canonical_lifecycle_events e WHERE e.turn_id = a.turn_id AND e.event_type IN ('turn.completed','turn.failed','turn.interrupted') ORDER BY e.sequence DESC LIMIT 1) terminal ON TRUE WHERE a.session_id = $1 AND a.turn_id = $2 AND a.admission_state = 'admitted' AND s.current_turn_id = a.turn_id AND NOT EXISTS (SELECT 1 FROM canonical_turn_admissions child WHERE child.session_id = a.session_id AND child.revision_of_turn_id = a.turn_id AND child.admission_state = 'admitted')`;
const INSERT_RESERVED_SQL = `INSERT INTO canonical_turn_admissions (session_id, client_message_id, thread_id, turn_id, run_attempt_id, run_id, workspace_id, revision_of_turn_id, continuation_of_turn_id, original_prompt_id, continuation_terminal_sequence, admission_state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'reserved') RETURNING *, (SELECT user_id FROM sessions WHERE id = $1) AS owner_user_id`;
const READ_CONTINUATION_TARGET_SQL = `SELECT a.turn_id FROM canonical_turn_admissions a JOIN sessions s ON s.id = a.session_id JOIN canonical_lifecycle_events terminal ON terminal.turn_id = a.turn_id AND terminal.event_type = 'turn.interrupted' AND terminal.sequence = $3 LEFT JOIN LATERAL (SELECT COALESCE(m.client_message_id, m.id::text) AS prompt_id FROM messages m WHERE m.session_id = a.session_id AND m.canonical_turn_id = a.turn_id AND m.role = 'user' ORDER BY m.created_at ASC, m.id ASC LIMIT 1) prompt ON a.original_prompt_id IS NULL WHERE a.session_id = $1 AND a.turn_id = $2 AND a.admission_state = 'admitted' AND s.current_turn_id = a.turn_id AND COALESCE(a.original_prompt_id, prompt.prompt_id) = $4 AND NOT EXISTS (SELECT 1 FROM canonical_turn_admissions child WHERE child.session_id = a.session_id AND child.continuation_of_turn_id = a.turn_id AND child.admission_state = 'admitted')`;
const READ_CONTINUATION_TARGET_FOR_COMMAND_SQL = `SELECT a.turn_id FROM canonical_turn_admissions a JOIN sessions s ON s.id = a.session_id JOIN canonical_lifecycle_events terminal ON terminal.turn_id = a.turn_id AND terminal.run_attempt_id = a.run_attempt_id AND terminal.event_type = 'turn.interrupted' AND terminal.sequence = $3 LEFT JOIN LATERAL (SELECT COALESCE(m.client_message_id, m.id::text) AS prompt_id FROM messages m WHERE m.session_id = a.session_id AND m.canonical_turn_id = a.turn_id AND m.role = 'user' ORDER BY m.created_at ASC, m.id ASC LIMIT 1) prompt ON a.original_prompt_id IS NULL WHERE a.session_id = $1 AND a.turn_id = $2 AND a.admission_state = 'admitted' AND COALESCE(a.original_prompt_id, prompt.prompt_id) = $4 AND ((s.current_turn_id = a.turn_id AND s.active_run_id IS NULL AND NOT EXISTS (SELECT 1 FROM canonical_turn_admissions child WHERE child.session_id = a.session_id AND child.continuation_of_turn_id = a.turn_id AND child.admission_state = 'admitted')) OR EXISTS (SELECT 1 FROM canonical_turn_admissions child WHERE child.session_id = a.session_id AND child.continuation_of_turn_id = a.turn_id AND child.client_message_id = $5 AND child.original_prompt_id = $4 AND child.continuation_terminal_sequence = $3 AND child.admission_state = 'admitted'))`;
const LOCK_THREAD_INPUT_STATE_SQL = `SELECT revision, paused FROM thread_input_state WHERE session_id = $1 AND thread_id = $2 AND workspace_id = $3 FOR UPDATE`;
const READ_THREAD_INPUT_REVISION_SQL = `SELECT revision FROM thread_input_state WHERE session_id = $1`;
const READ_CURRENT_COMPLETED_TURN_SQL = `SELECT 1 FROM sessions s JOIN LATERAL (SELECT event_type FROM canonical_lifecycle_events WHERE turn_id = s.current_turn_id ORDER BY sequence DESC LIMIT 1) terminal ON terminal.event_type = 'turn.completed' WHERE s.id = $1`;
const READ_QUEUED_START_SQL = `SELECT * FROM thread_inputs WHERE session_id = $1 AND user_id = $2 AND thread_id = $3 AND workspace_id = $4 AND id = $5`;
const READ_QUEUED_START_FOR_UPDATE_SQL = `${READ_QUEUED_START_SQL} FOR UPDATE`;
const CLAIM_QUEUED_START_SQL = `UPDATE thread_inputs SET state = 'consumed', receipt_json = $4::jsonb, version = version + 1, consumed_at = now(), updated_at = now() WHERE session_id = $1 AND id = $2 AND state = 'pending' AND delivery = 'queue' AND version = $3 RETURNING *`;
const CLEAR_THREAD_INPUT_PAUSE_SQL = `UPDATE thread_input_state SET paused = FALSE, pause_reason = NULL, revision = revision + 1, updated_at = now() WHERE session_id = $1 AND paused = TRUE`;
const READ_INTERRUPTED_TARGET_SQL = `SELECT a.*, s.user_id AS owner_user_id, root.prompt_id AS canonical_prompt_id, root.prompt_text, root.prompt_parts, root.source_run_id, terminal.event_json AS terminal_event_json, snapshot.event_json AS snapshot_event_json, artifact.event_json AS resume_artifact_event_json FROM canonical_turn_admissions a JOIN sessions s ON s.id = a.session_id JOIN canonical_lifecycle_events terminal ON terminal.turn_id = a.turn_id AND terminal.run_attempt_id = a.run_attempt_id AND terminal.event_type = 'turn.interrupted' AND terminal.sequence = $7 JOIN LATERAL (SELECT COALESCE(a.original_prompt_id, prompt.client_message_id, prompt.id::text) AS prompt_id, COALESCE(string_agg(part.content_json->>'text', '' ORDER BY part.session_sequence), '') AS prompt_text, COALESCE(json_agg(json_build_object('type', part.part_type, 'content', part.content_json) ORDER BY part.session_sequence) FILTER (WHERE part.id IS NOT NULL), '[]'::json) AS prompt_parts, root_admission.run_id AS source_run_id FROM messages prompt JOIN message_parts part ON part.message_id = prompt.id LEFT JOIN canonical_turn_admissions root_admission ON root_admission.turn_id = prompt.canonical_turn_id AND root_admission.session_id = prompt.session_id WHERE prompt.session_id = a.session_id AND prompt.role = 'user' AND ((a.original_prompt_id IS NOT NULL AND (prompt.id::text = a.original_prompt_id OR prompt.client_message_id = a.original_prompt_id)) OR (a.original_prompt_id IS NULL AND prompt.canonical_turn_id = a.turn_id)) GROUP BY prompt.id, root_admission.run_id ORDER BY prompt.created_at, prompt.id LIMIT 1) root ON TRUE LEFT JOIN LATERAL (SELECT e.event_json FROM canonical_lifecycle_events e WHERE e.turn_id = a.turn_id AND e.run_attempt_id = a.run_attempt_id AND e.event_type = 'workspace.snapshot_captured' AND e.sequence < terminal.sequence AND e.event_json->'payload'->'snapshot'->'snapshot'->>'phase' = 'terminal' AND e.event_json->'payload'->'snapshot'->'snapshot'->>'turnId' = a.turn_id AND e.event_json->'payload'->'snapshot'->'snapshot'->'resumeSnapshotRef'->>'artifactId' IS NOT NULL ORDER BY e.sequence DESC LIMIT 1) snapshot ON TRUE LEFT JOIN LATERAL (SELECT e.event_json FROM canonical_lifecycle_events e WHERE e.turn_id = a.turn_id AND e.run_attempt_id = a.run_attempt_id AND e.event_type = 'artifact.created' AND e.sequence < terminal.sequence AND e.event_json->'payload'->'artifact'->>'artifactId' = snapshot.event_json->'payload'->'snapshot'->'snapshot'->'resumeSnapshotRef'->>'artifactId' AND e.event_json->'payload'->'artifact'->'metadata'->>'role' = 'resume_workspace_progress' AND e.event_json->'payload'->'artifact'->'metadata'->>'sourceUserId' = $9 AND e.event_json->'payload'->'artifact'->'metadata'->>'sourceRunId' = a.run_id AND e.event_json->'payload'->'artifact'->'metadata'->>'sourceTurnId' = a.turn_id AND e.event_json->'payload'->'artifact'->'metadata'->>'sourceRunAttemptId' = a.run_attempt_id ORDER BY e.sequence DESC LIMIT 1) artifact ON TRUE WHERE (s.repository IS NULL OR (snapshot.event_json IS NOT NULL AND artifact.event_json IS NOT NULL)) AND a.session_id = $1 AND s.user_id = $2 AND s.workspace_id = $3 AND s.thread_id = $4 AND a.turn_id = $5 AND a.run_attempt_id = $6 AND a.admission_state = 'admitted' AND ((s.current_turn_id = a.turn_id AND NOT EXISTS (SELECT 1 FROM canonical_turn_admissions child WHERE child.session_id = a.session_id AND child.continuation_of_turn_id = a.turn_id AND child.admission_state = 'admitted')) OR EXISTS (SELECT 1 FROM canonical_turn_admissions child WHERE child.session_id = a.session_id AND child.continuation_of_turn_id = a.turn_id AND child.client_message_id = $8 AND child.original_prompt_id = root.prompt_id AND child.continuation_terminal_sequence = $7 AND child.admission_state = 'admitted'))`;
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
const BIND_PROMPT_TURN_IDENTITY_SQL = `UPDATE messages SET canonical_turn_id = $3, canonical_run_attempt_id = $4 WHERE session_id = $1 AND id = $2 AND role = 'user'`;
const ACTIVATE_CONTINUATION_SESSION_SQL = `UPDATE sessions SET active_run_id = $2, current_turn_id = $3, status = 'running', updated_at = now() WHERE id = $1 AND current_turn_id = $4 AND (active_run_id IS NULL OR active_run_id = $2) RETURNING id`;
const ACTIVATE_QUEUED_SESSION_SQL = `UPDATE sessions SET current_turn_id = $3, status = 'running', updated_at = now() WHERE id = $1 AND active_run_id = $2 RETURNING id`;
