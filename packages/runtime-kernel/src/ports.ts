import type {
  ItemId,
  Run,
  RunAttemptId,
  ToolCallItemContent,
  Turn,
} from "@repo/platform-protocol";
import type { LifecycleEventStore } from "@repo/event-store";
import type { GitService } from "@repo/git-service";
import type { TurnArtifactRepository } from "@repo/artifact-store";
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

export type RuntimeLifecycleEventStore = LifecycleEventStore;
export type RuntimeGitSnapshotPort = Pick<
  GitService,
  "captureSnapshot" | "getSnapshotDiff"
>;
export type RuntimeTurnArtifactPort = TurnArtifactRepository;
