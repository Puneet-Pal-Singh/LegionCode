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
  private readonly pending = new Map<
    string,
    PendingApprovalResolution
  >();

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
    signal?: AbortSignal,
  ): Promise<ApprovalResolution> {
    if (request.itemId === null || request.itemId === parentItemId) {
      throw new RuntimeKernelError(
        "invalid_approval_item",
        `Approval ${request.approvalId} requires a distinct approval item`,
      );
    }
    const pending = this.createPending(request.approvalId);
    try {
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
      const resolution = await raceApprovalResolution([
        this.approvals.waitForDecision({
          runId: run.id,
          runAttemptId,
          turnId: turn.id,
          request,
          signal,
        }),
        pending.resolution,
      ], signal);
      await this.settle(request.approvalId, pending, resolution);
      if (resolution.decision !== "approved") {
        throw new RuntimeKernelError(
          "approval_denied",
          `Approval ${request.approvalId} was ${resolution.decision}`,
        );
      }
      return resolution;
    } finally {
      this.pending.delete(request.approvalId);
    }
  }

  /**
   * Resolves an active approval through the same lifecycle coordinator as the
   * waiting tool loop. This is deliberately the only external entry point:
   * callers persist/authorize the decision first, then RuntimeKernel appends
   * the single canonical approval.decided event and wakes the loop.
   */
  async resolve(
    approvalId: ApprovalRequestedPayload["approvalId"],
    resolution: ApprovalResolution,
  ): Promise<void> {
    const pending = this.pending.get(approvalId);
    if (!pending) {
      throw new RuntimeKernelError(
        "approval_not_active",
        `Approval ${approvalId} is not active in this runtime kernel`,
      );
    }
    await this.settle(approvalId, pending, resolution);
    pending.resolve(resolution);
  }

  private createPending(
    approvalId: ApprovalRequestedPayload["approvalId"],
  ): PendingApprovalResolution {
    const existing = this.pending.get(approvalId);
    if (existing) {
      throw new RuntimeKernelError(
        "approval_already_active",
        `Approval ${approvalId} is already active in this runtime kernel`,
      );
    }
    let resolve!: (resolution: ApprovalResolution) => void;
    const resolution = new Promise<ApprovalResolution>((accept) => {
      resolve = accept;
    });
    const pending: PendingApprovalResolution = {
      resolution,
      resolve,
      settlement: null,
    };
    this.pending.set(approvalId, pending);
    return pending;
  }

  private async settle(
    approvalId: ApprovalRequestedPayload["approvalId"],
    pending: PendingApprovalResolution,
    resolution: ApprovalResolution,
  ): Promise<void> {
    pending.settlement ??= this.lifecycle.decideApproval(
      approvalId,
      resolution.decision,
      {
        decidedBy: resolution.decidedBy,
        reason: resolution.reason,
      },
    );
    await pending.settlement;
  }
}

interface PendingApprovalResolution {
  readonly resolution: Promise<ApprovalResolution>;
  readonly resolve: (resolution: ApprovalResolution) => void;
  settlement: Promise<void> | null;
}

function raceApprovalResolution(
  resolutions: readonly Promise<ApprovalResolution>[],
  signal?: AbortSignal,
): Promise<ApprovalResolution> {
  if (!signal) return Promise.race(resolutions);
  if (signal.aborted) {
    return Promise.reject(
      new RuntimeKernelError("turn_cancelled", "Turn cancelled by user."),
    );
  }
  return new Promise<ApprovalResolution>((resolve, reject) => {
    const abort = () =>
      reject(new RuntimeKernelError("turn_cancelled", "Turn cancelled by user."));
    signal.addEventListener("abort", abort, { once: true });
    Promise.race(resolutions).then(resolve, reject).finally(() =>
      signal.removeEventListener("abort", abort),
    );
  });
}
