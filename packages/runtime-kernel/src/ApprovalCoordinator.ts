import type {
  ApprovalRequestedPayload,
  Run,
  Turn,
} from "@repo/platform-protocol";
import { RuntimeKernelError } from "./errors.js";
import type { ApprovalWaitPort } from "./ports.js";
import { RuntimeEventEmitter } from "./RuntimeEventEmitter.js";
import type { ApprovalResolution } from "./types.js";

export class ApprovalCoordinator {
  constructor(
    private readonly approvals: ApprovalWaitPort,
    private readonly events: RuntimeEventEmitter,
  ) {}

  async requestAndWait(
    run: Run,
    turn: Turn,
    request: ApprovalRequestedPayload,
  ): Promise<ApprovalResolution> {
    await this.events.approvalRequested(run, turn, request);
    const resolution = await this.approvals.waitForDecision({
      runId: run.id,
      turnId: turn.id,
      request,
    });
    await this.events.approvalDecided(run, turn, request, resolution);
    if (resolution.decision !== "approved") {
      throw new RuntimeKernelError(
        "approval_denied",
        `Approval ${request.approvalId} was ${resolution.decision}`,
      );
    }
    return resolution;
  }
}
