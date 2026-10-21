import type {
  ApprovalDecision,
  ApprovalGrantScope,
  ApprovalRequestedPayload,
  ArtifactMetadata,
  ContextBudgetSnapshot,
  ItemId,
  JsonRecord,
  ProtocolError,
  Run,
  RunAttemptId,
  ToolCallItemContent,
  ToolCallBatchId,
  Turn,
  TurnId,
  UserId,
  UsageCostSnapshot,
} from "@repo/platform-protocol";
import type { CoreMessage } from "ai";
import type { WorkspaceManifest } from "@repo/workspace-core";

export interface RuntimeContext {
  readonly instructions: string;
  readonly metadata: JsonRecord;
  readonly budgetSnapshot?: ContextBudgetSnapshot;
  readonly usage?: UsageCostSnapshot;
}

export interface ToolResult {
  readonly toolCallId: ToolCallItemContent["toolCallId"];
  readonly output: JsonRecord;
  readonly failure?: ProtocolError;
}

export type ToolAuthorizationErrorCode =
  | "tool_not_registered"
  | "invalid_tool_input"
  | "tool_policy_denied";

export type ToolAuthorizationResult =
  | {
      readonly status: "authorized";
      readonly toolCall: ToolCallItemContent;
    }
  | {
      readonly status: "approval_required";
      readonly toolCall: ToolCallItemContent;
      readonly request: ApprovalRequestedPayload;
    }
  | {
      readonly status: "rejected";
      readonly code: ToolAuthorizationErrorCode;
      readonly reason: string;
    };

export type ProviderStep =
  | {
      readonly kind: "complete";
      readonly itemId: ItemId;
      readonly output: string;
      /** Provider-designated safe summary only; private reasoning must not be set here. */
      readonly reasoning?: {
        readonly text: string;
        readonly displaySafe: boolean;
      };
      readonly usage?: UsageCostSnapshot;
    }
  | {
      readonly kind: "tool_call";
      readonly itemId: ItemId;
      readonly content: ToolCallItemContent;
      readonly callBatchId?: ToolCallBatchId;
      readonly commentary?: string;
      /** Provider-designated safe summary only; private reasoning must not be set here. */
      readonly reasoning?: {
        readonly text: string;
        readonly displaySafe: boolean;
      };
      readonly usage?: UsageCostSnapshot;
    };

export type WorkerToolResult =
  | {
      readonly kind: "completed";
      readonly output: JsonRecord;
      readonly events?: readonly WorkerToolRuntimeEvent[];
    }
  | {
      readonly kind: "failed";
      readonly failure: ProtocolError;
      readonly disposition: "recoverable" | "terminal";
    }
  | {
      readonly kind: "cancelled";
      readonly reason: string;
    }
  | {
      readonly kind: "approval_required";
      readonly request: ApprovalRequestedPayload;
    };

export type WorkerToolRuntimeEvent =
  | {
      readonly type: "tool_output_delta";
      readonly delta: string;
    }
  | {
      readonly type: "artifact_created";
      readonly artifact: ArtifactMetadata;
    };

export interface ApprovalResolution {
  readonly decision: ApprovalDecision;
  readonly decidedBy: UserId | null;
  readonly reason: string | null;
  /** The request expired without a user decision; decision remains denied for protocol compatibility. */
  readonly timedOut?: boolean;
  readonly grantScope?: ApprovalGrantScope;
}

export interface StartTurnInput {
  readonly run: Run;
  readonly turn: Turn;
  readonly runAttemptId: RunAttemptId;
  readonly continuationOfTurnId?: TurnId;
  readonly originalPromptId?: string;
}

export interface StartTurnResult {
  readonly status: "completed";
  readonly output: string;
  readonly toolCallCount: number;
  readonly workspace: WorkspaceManifest | null;
}

export interface ProviderCallInput {
  readonly run: Run;
  readonly runAttemptId: RunAttemptId;
  readonly turn: Turn;
  readonly workspace: WorkspaceManifest | null;
  readonly context: RuntimeContext;
  readonly toolResults: readonly ToolResult[];
  readonly onThreadInputsApplied?: (
    inputs: readonly AppliedThreadInput[],
  ) => Promise<void>;
  /** Rebuilds shared context after accepted inputs are staged at a model boundary. */
  readonly refreshContext?: () => Promise<RuntimeContext>;
  readonly signal?: AbortSignal;
}

export interface AcceptedThreadInput {
  readonly inputId: string;
  readonly acceptedSequence: number;
  readonly message: CoreMessage;
}

export interface AppliedThreadInput {
  readonly inputId: string;
  readonly acceptedSequence: number;
  readonly modelStep: number;
  readonly contextRevision: number;
}
