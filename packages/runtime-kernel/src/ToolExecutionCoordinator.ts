import type {
  ItemId,
  ProtocolError,
  Run,
  RunAttemptId,
  ToolCallItemContent,
  Turn,
} from "@repo/platform-protocol";
import type { WorkspaceManifest } from "@repo/workspace-core";
import { ApprovalCoordinator } from "./ApprovalCoordinator.js";
import { RuntimeKernelError, toProtocolError } from "./errors.js";
import type { ToolAuthorizationPort, WorkerProtocolPort } from "./ports.js";
import { RuntimeLifecycleCoordinator } from "./RuntimeLifecycleCoordinator.js";
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
    private readonly lifecycle: RuntimeLifecycleCoordinator,
  ) {}

  async execute(
    run: Run,
    runAttemptId: RunAttemptId,
    turn: Turn,
    workspace: WorkspaceManifest,
    itemId: ItemId,
    toolCall: ToolCallItemContent,
  ): Promise<ToolResult> {
    await this.lifecycle.startToolCall(
      itemId,
      toolCall.toolCallId,
      toolCall.input,
    );
    try {
      return await this.executeAuthorizedTool(
        run,
        runAttemptId,
        turn,
        workspace,
        itemId,
        toolCall,
      );
    } catch (error) {
      if (
        error instanceof RuntimeKernelError &&
        error.code === "approval_denied"
      ) {
        await this.lifecycle.declineToolCall(
          toolCall.toolCallId,
          error.message,
        );
      } else {
        await this.lifecycle.failToolCall(
          toolCall.toolCallId,
          toProtocolError(error),
        );
      }
      throw error;
    }
  }

  private async executeAuthorizedTool(
    run: Run,
    runAttemptId: RunAttemptId,
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
        ? await this.approvals.requestAndWait(
            run,
            runAttemptId,
            turn,
            itemId,
            authorization.request,
          )
        : null;
    const result = await this.executeToCompletion(
      run,
      runAttemptId,
      turn,
      workspace,
      itemId,
      authorization.toolCall,
      approval,
    );
    await this.emitWorkerResultEvents(
      run,
      itemId,
      authorization.toolCall,
      result,
    );
    await this.lifecycle.completeToolCall(toolCall.toolCallId, result.output);
    return { toolCallId: toolCall.toolCallId, output: result.output };
  }

  private async executeToCompletion(
    run: Run,
    runAttemptId: RunAttemptId,
    turn: Turn,
    workspace: WorkspaceManifest,
    itemId: ItemId,
    toolCall: ToolCallItemContent,
    approval: ApprovalResolution | null,
  ): Promise<Extract<WorkerToolResult, { kind: "completed" }>> {
    const initial = await this.callWorker(
      run,
      runAttemptId,
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
      runAttemptId,
      turn,
      itemId,
      initial.request,
    );
    return await this.resolveApprovedRetry(
      run,
      runAttemptId,
      turn,
      workspace,
      toolCall,
      workerApproval,
    );
  }

  private async resolveApprovedRetry(
    run: Run,
    runAttemptId: RunAttemptId,
    turn: Turn,
    workspace: WorkspaceManifest,
    toolCall: ToolCallItemContent,
    approval: ApprovalResolution,
  ): Promise<Extract<WorkerToolResult, { kind: "completed" }>> {
    const result = await this.callWorker(
      run,
      runAttemptId,
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
    runAttemptId: RunAttemptId,
    turn: Turn,
    workspace: WorkspaceManifest,
    toolCall: ToolCallItemContent,
    approval: ApprovalResolution | null,
  ): Promise<WorkerToolResult> {
    return await this.worker.executeTool({
      runId: run.id,
      runAttemptId,
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
    for (const delta of projection.outputDeltas) {
      await this.lifecycle.appendToolOutput(toolCall.toolCallId, delta);
    }
    for (const artifact of projection.artifacts) {
      await this.lifecycle.createArtifact(itemId, artifact);
    }
  }
}
