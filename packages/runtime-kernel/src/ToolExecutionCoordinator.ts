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
import type { ToolAuthorizationPort, WorkerProtocolPort } from "./ports.js";
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
    private readonly authorization: ToolAuthorizationPort,
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
      return await this.executeAuthorizedTool(
        run,
        turn,
        workspace,
        itemId,
        toolCall,
      );
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

  private async executeAuthorizedTool(
    run: Run,
    turn: Turn,
    workspace: WorkspaceManifest,
    itemId: ItemId,
    toolCall: ToolCallItemContent,
  ): Promise<ToolResult> {
    const authorization = await this.authorization.authorize({
      run,
      itemId,
      toolCall,
    });
    if (authorization.status === "rejected") {
      throw new RuntimeKernelError(authorization.code, authorization.reason);
    }
    const approval =
      authorization.status === "approval_required"
        ? await this.approvals.requestAndWait(run, turn, authorization.request)
        : null;
    const result = await this.executeToCompletion(
      run,
      turn,
      workspace,
      authorization.toolCall,
      approval,
    );
    await this.emitWorkerResultEvents(
      run,
      turn,
      itemId,
      authorization.toolCall,
      result,
    );
    await this.events.toolCompleted(
      run,
      turn,
      itemId,
      toolCall.toolCallId,
      result.output,
    );
    return { toolCallId: toolCall.toolCallId, output: result.output };
  }

  private async executeToCompletion(
    run: Run,
    turn: Turn,
    workspace: WorkspaceManifest,
    toolCall: ToolCallItemContent,
    approval: ApprovalResolution | null,
  ): Promise<Extract<WorkerToolResult, { kind: "completed" }>> {
    const initial = await this.callWorker(
      run,
      turn,
      workspace,
      toolCall,
      approval,
    );
    if (initial.kind === "completed") {
      return initial;
    }
    if (initial.kind === "failed") {
      throw this.workerFailure(initial.failure);
    }
    if (approval !== null) {
      throw new RuntimeKernelError(
        "approval_retry_required",
        `Worker requested approval again for ${toolCall.toolCallId}`,
      );
    }
    const workerApproval = await this.approvals.requestAndWait(
      run,
      turn,
      initial.request,
    );
    return await this.resolveApprovedRetry(
      run,
      turn,
      workspace,
      toolCall,
      workerApproval,
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
