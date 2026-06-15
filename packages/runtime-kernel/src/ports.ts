import type { Run, ToolCallItemContent, Turn } from "@repo/platform-protocol";
import type { WorkspaceManifest } from "@repo/workspace-core";
import type {
  ApprovalResolution,
  ProviderCallInput,
  ProviderStep,
  RuntimeContext,
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

export interface WorkerProtocolPort {
  executeTool(input: {
    runId: Run["id"];
    turnId: Turn["id"];
    workspace: WorkspaceManifest;
    toolCall: ToolCallItemContent;
    approval: ApprovalResolution | null;
  }): Promise<WorkerToolResult>;
}

export interface ApprovalWaitPort {
  waitForDecision(input: {
    runId: Run["id"];
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
