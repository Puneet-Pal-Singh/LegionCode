import type {
  EventId,
  ItemId,
  JsonRecord,
  LifecycleEventType,
  Run,
  RunAttemptId,
  ToolCallItemContent,
  Turn,
  TurnDiffPayload,
  TurnWorkspaceSnapshot,
} from "@repo/platform-protocol";
import type { LifecycleEventStore } from "@repo/event-store";
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

export type RuntimeHookAuditEventType = Extract<
  LifecycleEventType,
  | "hook.invocation.started"
  | "hook.invocation.completed"
  | "hook.invocation.failed"
  | "hook.invocation.timed_out"
  | "hook.invocation.cancelled"
>;

export interface RuntimeHookAuditAppender {
  appendHookAudit(
    eventType: RuntimeHookAuditEventType,
    payload: JsonRecord,
  ): Promise<void>;
}

export interface RuntimeHookTriggerInput {
  readonly run: Run;
  readonly turn: Turn;
  readonly runAttemptId: RunAttemptId;
  readonly workspace: WorkspaceManifest;
  readonly triggerEventId: EventId;
  readonly auditAppender: RuntimeHookAuditAppender;
}

/**
 * Runtime owns trigger order and lifecycle truth. Implementations may execute
 * handlers and append sanitized audits, but cannot settle a turn or apply an
 * outcome.
 */
export interface RuntimeHookOrchestrationPort {
  runSessionStart(input: RuntimeHookTriggerInput): Promise<void>;
  runUserPromptSubmit(input: RuntimeHookTriggerInput): Promise<void>;
}

export type RuntimeLifecycleEventStore = LifecycleEventStore;

export interface RuntimeGitWorkspaceSnapshot {
  readonly runId: Run["id"];
  readonly filesystemRoot: string;
  readonly headSha: string;
  readonly treeId: string;
}

export interface RuntimeGitSnapshotPort {
  captureSnapshot(input: {
    readonly workspace: {
      readonly runId: Run["id"];
      readonly filesystemRoot: string;
    };
    readonly snapshotKey: string;
  }): Promise<RuntimeGitWorkspaceSnapshot>;
  getSnapshotDiff(input: {
    readonly workspace: {
      readonly runId: Run["id"];
      readonly filesystemRoot: string;
    };
    readonly start: RuntimeGitWorkspaceSnapshot;
    readonly terminal: RuntimeGitWorkspaceSnapshot;
  }): Promise<{
    readonly files: readonly RuntimeGitDiffFile[];
    readonly patch: string;
  }>;
}

export interface RuntimeGitDiffFile {
  readonly path: string;
  readonly previousPath: string | null;
  readonly status:
    | "added"
    | "copied"
    | "deleted"
    | "modified"
    | "renamed"
    | "type_changed"
    | "unmerged"
    | "untracked";
  readonly additions: number;
  readonly deletions: number;
}

interface RuntimeArtifactOwnership {
  readonly createdBy: Run["userId"];
  readonly workspaceId: Run["workspaceId"];
  readonly threadId: Run["threadId"];
  readonly runId: Run["id"];
}

interface RuntimeArtifactAccess {
  readonly userId: Run["userId"];
  readonly workspaceId: Run["workspaceId"];
  readonly threadId: Run["threadId"];
  readonly runId: Run["id"];
}

export interface RuntimeTurnArtifactPort {
  putSnapshot(input: {
    readonly snapshot: TurnWorkspaceSnapshot;
    readonly ownership: RuntimeArtifactOwnership;
    readonly access: RuntimeArtifactAccess;
  }): Promise<unknown>;
  putTurnDiff(input: {
    readonly diff: TurnDiffPayload;
    readonly ownership: RuntimeArtifactOwnership;
    readonly access: RuntimeArtifactAccess;
  }): Promise<unknown>;
}
