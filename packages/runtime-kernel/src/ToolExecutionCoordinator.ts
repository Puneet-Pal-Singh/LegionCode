import type {
  ItemId,
  ProtocolError,
  Run,
  ToolCallItemContent,
  Turn,
} from "@repo/platform-protocol";
import type { WorkspaceManifest } from "@repo/workspace-core";
import { ApprovalCoordinator } from "./ApprovalCoordinator.js";
import { RuntimeKernelError, toProtocolError } from "./errors.js";
import type { WorkerProtocolPort } from "./ports.js";
import { RuntimeEventEmitter } from "./RuntimeEventEmitter.js";
import type {
  ApprovalResolution,
  ToolResult,
  WorkerToolResult,
} from "./types.js";
import { mapWorkerResultEvents } from "./WorkerResultEventMapper.js";

export class ToolExecutionCoordinator {
  constructor(
    private readonly worker: WorkerProtocolPort,
    private readonly approvals: ApprovalCoordinator,
    private readonly events: RuntimeEventEmitter,
  ) {}

  async execute(
    run: Run,
    turn: Turn,
    workspace: WorkspaceManifest,
    itemId: ItemId,
    toolCall: ToolCallItemContent,
  ): Promise<ToolResult> {
    await this.events.toolRequested(run, turn, itemId, toolCall);
    await this.events.toolStarted(run, turn, itemId, toolCall.toolCallId);
    try {
      const result = await this.executeToCompletion(
        run,
        turn,
        workspace,
        toolCall,
      );
      await this.emitWorkerResultEvents(run, turn, itemId, toolCall, result);
      await this.events.toolCompleted(
        run,
        turn,
        itemId,
        toolCall.toolCallId,
        result.output,
      );
      return { toolCallId: toolCall.toolCallId, output: result.output };
    } catch (error) {
      await this.events.toolFailed(
        run,
        turn,
        itemId,
        toolCall.toolCallId,
        toProtocolError(error),
      );
      throw error;
    }
  }

  private async executeToCompletion(
    run: Run,
    turn: Turn,
    workspace: WorkspaceManifest,
    toolCall: ToolCallItemContent,
  ): Promise<Extract<WorkerToolResult, { kind: "completed" }>> {
    const initial = await this.callWorker(run, turn, workspace, toolCall, null);
    if (initial.kind === "completed") {
      return initial;
    }
    if (initial.kind === "failed") {
      throw this.workerFailure(initial.failure);
    }
    const approval = await this.approvals.requestAndWait(
      run,
      turn,
      initial.request,
    );
    return await this.resolveApprovedRetry(
      run,
      turn,
      workspace,
      toolCall,
      approval,
    );
  }

  private async resolveApprovedRetry(
    run: Run,
    turn: Turn,
    workspace: WorkspaceManifest,
    toolCall: ToolCallItemContent,
    approval: ApprovalResolution,
  ): Promise<Extract<WorkerToolResult, { kind: "completed" }>> {
    const result = await this.callWorker(
      run,
      turn,
      workspace,
      toolCall,
      approval,
    );
    if (result.kind === "approval_required") {
      throw new RuntimeKernelError(
        "approval_retry_required",
        `Worker requested approval again for ${toolCall.toolCallId}`,
      );
    }
    if (result.kind === "failed") {
      throw this.workerFailure(result.failure);
    }
    return result;
  }

  private async callWorker(
    run: Run,
    turn: Turn,
    workspace: WorkspaceManifest,
    toolCall: ToolCallItemContent,
    approval: ApprovalResolution | null,
  ): Promise<WorkerToolResult> {
    return await this.worker.executeTool({
      runId: run.id,
      turnId: turn.id,
      workspace,
      toolCall,
      approval,
    });
  }

  private workerFailure(failure: ProtocolError): RuntimeKernelError {
    return new RuntimeKernelError("worker_failed", failure.message, failure);
  }

  private async emitWorkerResultEvents(
    run: Run,
    turn: Turn,
    itemId: ItemId,
    toolCall: ToolCallItemContent,
    result: Extract<WorkerToolResult, { kind: "completed" }>,
  ): Promise<void> {
    const projection = mapWorkerResultEvents(
      run,
      itemId,
      result.output,
      result.events,
    );
    for (const [index, delta] of projection.outputDeltas.entries()) {
      await this.events.toolOutputDelta(
        run,
        turn,
        itemId,
        toolCall.toolCallId,
        delta,
        index,
      );
    }
    for (const artifact of projection.artifacts) {
      await this.events.artifactCreated(run, itemId, artifact);
    }
  }
}
