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

export interface TurnAdmissionRepository {
  reserve(input: ReserveTurnAdmissionInput): Promise<TurnAdmissionRecord>;
  admitWithPrompt(input: AdmitTurnWithPromptInput): Promise<{ admission: TurnAdmissionRecord; promptMessageId: string; run: RunRecord }>;
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
