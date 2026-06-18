import type {
  ItemId,
  LifecycleEvent,
  Run,
  RunAttemptId,
  ToolCallItemContent,
  Turn,
} from "@repo/platform-protocol";
import type { WorkspaceManifest } from "@repo/workspace-core";
import type {
  ApprovalResolution,
  ProviderCallInput,
  ProviderStep,
  RuntimeContext,
  ToolAuthorizationResult,
  WorkerToolResult,
} from "./types.js";

export interface ContextAssemblyPort {
  assemble(input: {
    run: Run;
    turn: Turn;
    workspace: WorkspaceManifest;
  }): Promise<RuntimeContext>;
}

export interface ProviderPort {
  generateNext(input: ProviderCallInput): Promise<ProviderStep>;
}

export interface ToolAuthorizationPort {
  authorize(input: {
    run: Run;
    itemId: ItemId;
    toolCall: ToolCallItemContent;
  }): Promise<ToolAuthorizationResult>;
}

export interface WorkerProtocolPort {
  executeTool(input: {
    runId: Run["id"];
    runAttemptId: RunAttemptId;
    turnId: Turn["id"];
    workspace: WorkspaceManifest;
    toolCall: ToolCallItemContent;
    approval: ApprovalResolution | null;
  }): Promise<WorkerToolResult>;
}

export interface ApprovalWaitPort {
  waitForDecision(input: {
    runId: Run["id"];
    runAttemptId: RunAttemptId;
    turnId: Turn["id"];
    request: Extract<
      WorkerToolResult,
      { kind: "approval_required" }
    >["request"];
  }): Promise<ApprovalResolution>;
}

export interface RuntimeKernelClock {
  now(): string;
}

export interface LifecycleEventSink {
  appendBatch(
    events: readonly LifecycleEvent[],
  ): Promise<readonly LifecycleEvent[]>;
}
