import type { JsonValue } from "@repo/shared-types";
import type { RunRecord, RunStatus } from "../runs/types.js";
import type { TranscriptMessagePartType } from "../sessions/types.js";

export interface TurnAdmissionRecord {
  userId: string;
  sessionId: string;
  clientMessageId: string;
  threadId: string;
  turnId: string;
  runAttemptId: string;
  runId: string;
  workspaceId: string | null;
  revisionOfTurnId: string | null;
  continuationOfTurnId: string | null;
  originalPromptId: string | null;
  continuationTerminalSequence: number | null;
  state: "reserved" | "admitted";
  executionState: "pending" | "running" | "recovery_required" | "settled";
  requestFingerprint: string | null;
  admissionOrder: number | null;
  createdAt: string;
  admittedAt: string | null;
}

export interface ReserveTurnAdmissionInput {
  sessionId: string;
  userId: string;
  workspaceId: string | null;
  clientMessageId: string;
  threadId: string;
  turnId: string;
  runAttemptId: string;
  runId: string;
  revisionOfTurnId?: string | null;
  continuationOfTurnId?: string | null;
  originalPromptId?: string | null;
  continuationTerminalSequence?: number | null;
}

export interface AdmitTurnWithPromptInput {
  sessionId: string;
  clientMessageId: string;
  turnId: string;
  runAttemptId: string;
  runId: string;
  requestFingerprint: string;
  userId: string;
  workspaceId: string;
  taskId: string;
  mode: string;
  providerId?: string | null;
  modelId?: string | null;
  branch?: string | null;
  runStatus?: RunStatus;
  promptMessage: {
    role: "user";
    clientMessageId: string;
    dedupeKey: string;
    parts: Array<{ type: TranscriptMessagePartType; content: JsonValue }>;
  };
}

export interface AdmitContinuationInput extends Omit<AdmitTurnWithPromptInput, "promptMessage"> {
  readonly threadId: string;
  readonly continuationOfTurnId: string;
  readonly originalPromptId: string;
  readonly continuationTerminalSequence: number;
}

export interface ReserveQueuedStartInput extends Omit<ReserveTurnAdmissionInput, "clientMessageId" | "continuationOfTurnId" | "originalPromptId" | "continuationTerminalSequence"> {
  readonly expectedRevision: number;
  readonly itemId: string;
  readonly expectedVersion: number;
  /** True only for an explicit user start; automatic drain must respect pause state. */
  readonly explicitStart?: boolean;
  readonly taskId: string;
  readonly requestFingerprint: string;
  readonly mode: string;
  readonly providerId?: string | null;
  readonly modelId?: string | null;
  readonly branch?: string | null;
  readonly promptMessage: {
    readonly parts: Array<{ readonly type: TranscriptMessagePartType; readonly content: JsonValue }>;
  };
}

export interface ReserveQueuedStartResult {
  readonly status: "admitted" | "conflict";
  readonly admission: TurnAdmissionRecord | null;
  readonly revision: number;
  readonly acceptedInput: { readonly inputId: string; readonly clientInputId: string } | null;
  readonly promptMessageId: string | null;
  readonly run: RunRecord | null;
  readonly item: {
    readonly itemId: string;
    readonly clientInputId: string;
    readonly version: number;
    readonly text: string;
    readonly mediaRefs: import("@repo/platform-protocol").ThreadInputQueueItem["mediaRefs"];
    readonly configuration: import("@repo/platform-protocol").ThreadInputQueueItem["configuration"];
    readonly receipt: import("@repo/platform-protocol").ThreadInputQueueItem["receipt"];
  } | null;
  readonly code?: "queue_revision_conflict" | "queue_item_changed" | "queue_item_consumed" | "turn_not_idle" | "queue_paused";
}

export interface InterruptedTurnTargetInput {
  readonly sessionId: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly runAttemptId: string;
  readonly terminalSequence: number;
  readonly clientMessageId: string;
}

export interface InterruptedTurnTarget {
  readonly admission: TurnAdmissionRecord;
  readonly originalPromptId: string;
  readonly prompt: {
    readonly text: string;
    readonly parts: Array<{ type: TranscriptMessagePartType; content: JsonValue }>;
  };
  readonly run: RunRecord;
  readonly terminalEvent: JsonValue;
  readonly snapshotEvent: JsonValue;
  readonly resumeArtifactEvent: JsonValue;
}

export interface TurnAdmissionRepository {
  reserve(input: ReserveTurnAdmissionInput): Promise<TurnAdmissionRecord>;
  admitWithPrompt(input: AdmitTurnWithPromptInput): Promise<{ admission: TurnAdmissionRecord; promptMessageId: string; run: RunRecord }>;
  admitContinuation(input: AdmitContinuationInput): Promise<{ admission: TurnAdmissionRecord; run: RunRecord }>;
  getInterruptedTarget(input: InterruptedTurnTargetInput): Promise<InterruptedTurnTarget | null>;
  reserveQueuedStart(input: ReserveQueuedStartInput): Promise<ReserveQueuedStartResult>;
  getByTurnId(turnId: string): Promise<TurnAdmissionRecord | null>;
  getBySessionAndClientMessage(
    sessionId: string,
    clientMessageId: string,
  ): Promise<TurnAdmissionRecord | null>;
  getBySessionAndRunId(sessionId: string, runId: string): Promise<TurnAdmissionRecord | null>;
  claimExecution(input: {
    turnId: string;
    runAttemptId: string;
    runId: string;
    sessionId: string;
    userId: string;
    workspaceId: string;
    threadId: string;
    claimId: string;
  }): Promise<{ status: "claimed" | "already_claimed" | "recovery_required" | "settled" | "conflict"; admission: TurnAdmissionRecord | null }>;
  markRecoveryRequired(input: { turnId: string; claimId: string }): Promise<boolean>;
}
