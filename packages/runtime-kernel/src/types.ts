import type {
  ApprovalDecision,
  ApprovalRequestedPayload,
  ArtifactMetadata,
  ContextBudgetSnapshot,
  ItemId,
  JsonRecord,
  ProtocolError,
  Run,
  RunAttemptId,
  ToolCallItemContent,
  Turn,
  UserId,
  UsageCostSnapshot,
} from "@repo/platform-protocol";
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
      readonly usage?: UsageCostSnapshot;
    }
  | {
      readonly kind: "tool_call";
      readonly itemId: ItemId;
      readonly content: ToolCallItemContent;
      readonly commentary?: string;
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
}

export interface StartTurnInput {
  readonly run: Run;
  readonly turn: Turn;
  readonly runAttemptId: RunAttemptId;
}

export interface StartTurnResult {
  readonly status: "completed";
  readonly output: string;
  readonly toolCallCount: number;
  readonly workspace: WorkspaceManifest;
}

export interface ProviderCallInput {
  readonly run: Run;
  readonly runAttemptId: RunAttemptId;
  readonly turn: Turn;
  readonly workspace: WorkspaceManifest;
  readonly context: RuntimeContext;
  readonly toolResults: readonly ToolResult[];
  readonly signal?: AbortSignal;
}
