import type { JsonValue } from "@repo/shared-types";
import type { RunRecord, RunStatus } from "../runs/types.js";
import type { TranscriptMessagePartType } from "../sessions/types.js";

export interface TurnAdmissionRecord {
  readonly harnessSelection?: import("@repo/platform-protocol").HarnessAdmissionSelection | null;
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
  /** Persist with the admitted fingerprint/binding in the canonical transaction. */
