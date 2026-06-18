import type { AppendEventInput, EventStore } from "@repo/event-store";
import {
  EVENT_SCHEMA_VERSION,
  type ArtifactMetadata,
  type ApprovalRequestedPayload,
  type ItemId,
  type JsonRecord,
  type ProtocolError,
  type Run,
  type ToolCallItemContent,
  type Turn,
} from "@repo/platform-protocol";
import type { ApprovalResolution } from "./types.js";

export class RuntimeEventEmitter {
  constructor(
    private readonly eventStore: EventStore,
    private readonly producerId: string,
  ) {}

  async turnStarted(run: Run, turn: Turn): Promise<void> {
    await this.appendRunEvent(run, "turn.started", `turn:${turn.id}:started`, {
      turn,
    });
  }

  async turnCompleted(run: Run, turn: Turn): Promise<void> {
    await this.appendRunEvent(
      run,
      "turn.completed",
      `turn:${turn.id}:completed`,
      { turn },
    );
  }

  async turnFailed(
    run: Run,
    turn: Turn,
    failure: ProtocolError,
  ): Promise<void> {
    await this.appendRunEvent(run, "turn.failed", `turn:${turn.id}:failed`, {
      turn,
      failure,
    });
  }

  async toolRequested(
    run: Run,
    turn: Turn,
    itemId: ItemId,
    content: ToolCallItemContent,
  ): Promise<void> {
    await this.appendRunEvent(
      run,
      "tool.call.requested",
      `turn:${turn.id}:tool:${content.toolCallId}:requested`,
      { itemId, content },
    );
  }

  async toolStarted(
    run: Run,
    turn: Turn,
    itemId: ItemId,
    toolCallId: ToolCallItemContent["toolCallId"],
  ): Promise<void> {
    await this.appendRunEvent(
      run,
      "tool.call.started",
      `turn:${turn.id}:tool:${toolCallId}:started`,
      { itemId, toolCallId },
    );
  }

  async toolCompleted(
    run: Run,
    turn: Turn,
    itemId: ItemId,
    toolCallId: ToolCallItemContent["toolCallId"],
    output: JsonRecord,
  ): Promise<void> {
    await this.appendRunEvent(
      run,
      "tool.call.completed",
      `turn:${turn.id}:tool:${toolCallId}:completed`,
      { itemId, toolCallId, output },
    );
  }

  async toolOutputDelta(
    run: Run,
    turn: Turn,
    itemId: ItemId,
    toolCallId: ToolCallItemContent["toolCallId"],
    delta: string,
    index: number,
  ): Promise<void> {
    await this.appendRunEvent(
      run,
      "tool.call.output.delta",
      `turn:${turn.id}:tool:${toolCallId}:output:${index}`,
      { itemId, toolCallId, delta },
    );
  }

  async toolFailed(
    run: Run,
    turn: Turn,
    itemId: ItemId,
    toolCallId: ToolCallItemContent["toolCallId"],
    failure: ProtocolError,
  ): Promise<void> {
    await this.appendRunEvent(
      run,
      "tool.call.failed",
      `turn:${turn.id}:tool:${toolCallId}:failed`,
      { itemId, toolCallId, failure },
    );
  }

  async artifactCreated(
    run: Run,
    itemId: ItemId | null,
    artifact: ArtifactMetadata,
  ): Promise<void> {
    await this.eventStore.append({
      threadId: run.threadId,
      workspaceId: run.workspaceId,
      runId: run.id,
      scopeType: "artifact",
      scopeId: artifact.artifactId,
      idempotencyKey: `artifact:${artifact.artifactId}:created`,
      producer: { kind: "runtime_kernel", id: this.producerId },
      schemaVersion: EVENT_SCHEMA_VERSION,
      type: "artifact.created",
      payload: { itemId, artifact },
    });
  }

  async approvalRequested(
    run: Run,
    turn: Turn,
    request: ApprovalRequestedPayload,
  ): Promise<void> {
    await this.appendRunEvent(
      run,
      "approval.requested",
      `turn:${turn.id}:approval:${request.approvalId}:requested`,
      request,
    );
  }

  async approvalDecided(
    run: Run,
    turn: Turn,
    request: ApprovalRequestedPayload,
    resolution: ApprovalResolution,
  ): Promise<void> {
    await this.appendRunEvent(
      run,
      "approval.decided",
      `turn:${turn.id}:approval:${request.approvalId}:decided`,
      {
        approvalId: request.approvalId,
        decision: resolution.decision,
        decidedBy: resolution.decidedBy,
        reason: resolution.reason,
      },
    );
  }

  private async appendRunEvent(
    run: Run,
    type: AppendEventInput["type"],
    idempotencyKey: string,
    payload: AppendEventInput["payload"],
  ): Promise<void> {
    await this.eventStore.append({
      threadId: run.threadId,
      workspaceId: run.workspaceId,
      runId: run.id,
      scopeType: "run",
      scopeId: run.id,
      idempotencyKey,
      producer: { kind: "runtime_kernel", id: this.producerId },
      schemaVersion: EVENT_SCHEMA_VERSION,
      type,
      payload,
    } as AppendEventInput);
  }
}
