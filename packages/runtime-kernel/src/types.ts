import type {
  ApprovalDecision,
  ApprovalRequestedPayload,
  ItemId,
  JsonRecord,
  ProtocolError,
  Run,
  ToolCallItemContent,
  Turn,
  UserId,
} from "@repo/platform-protocol";
import type { WorkspaceManifest } from "@repo/workspace-core";

export interface RuntimeContext {
  readonly instructions: string;
  readonly metadata: JsonRecord;
}

export interface ToolResult {
  readonly toolCallId: ToolCallItemContent["toolCallId"];
  readonly output: JsonRecord;
}

export type ProviderStep =
  | {
      readonly kind: "complete";
      readonly output: string;
    }
  | {
      readonly kind: "tool_call";
      readonly itemId: ItemId;
      readonly content: ToolCallItemContent;
    };

export type WorkerToolResult =
  | {
      readonly kind: "completed";
      readonly output: JsonRecord;
    }
  | {
      readonly kind: "failed";
      readonly failure: ProtocolError;
    }
  | {
      readonly kind: "approval_required";
      readonly request: ApprovalRequestedPayload;
    };

export interface ApprovalResolution {
  readonly decision: ApprovalDecision;
  readonly decidedBy: UserId | null;
  readonly reason: string | null;
}

export interface StartTurnInput {
  readonly run: Run;
  readonly turn: Turn;
}

export interface StartTurnResult {
  readonly status: "completed";
  readonly output: string;
  readonly toolCallCount: number;
  readonly workspace: WorkspaceManifest;
}

export interface ProviderCallInput {
  readonly run: Run;
  readonly turn: Turn;
  readonly workspace: WorkspaceManifest;
  readonly context: RuntimeContext;
  readonly toolResults: readonly ToolResult[];
}
