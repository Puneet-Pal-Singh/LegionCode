import type {
  ApprovalRequestedPayload,
  ItemId,
  Run,
  RunAttemptId,
  Turn,
} from "@repo/platform-protocol";
import { RuntimeKernelError } from "./errors.js";
import type { ApprovalWaitPort } from "./ports.js";
import { RuntimeLifecycleCoordinator } from "./RuntimeLifecycleCoordinator.js";
import type { ApprovalResolution } from "./types.js";

export class ApprovalCoordinator {
  constructor(
    private readonly approvals: ApprovalWaitPort,
    private readonly lifecycle: RuntimeLifecycleCoordinator,
  ) {}

  async requestAndWait(
    run: Run,
    runAttemptId: RunAttemptId,
    turn: Turn,
    parentItemId: ItemId,
    request: ApprovalRequestedPayload,
  ): Promise<ApprovalResolution> {
    if (request.itemId === null || request.itemId === parentItemId) {
      throw new RuntimeKernelError(
        "invalid_approval_item",
        `Approval ${request.approvalId} requires a distinct approval item`,
      );
    }
    await this.lifecycle.requestApproval(
      parentItemId,
      request.approvalId,
      request.itemId,
      {
        question: request.question,
        options: request.options,
        metadata: request.metadata,
      },
    );
    const resolution = await this.approvals.waitForDecision({
      runId: run.id,
      runAttemptId,
      turnId: turn.id,
      request,
    });
    await this.lifecycle.decideApproval(request.approvalId, resolution.decision, {
      decidedBy: resolution.decidedBy,
      reason: resolution.reason,
    });
    if (resolution.decision !== "approved") {
      throw new RuntimeKernelError(
        "approval_denied",
        `Approval ${request.approvalId} was ${resolution.decision}`,
      );
    }
    return resolution;
  }
}
