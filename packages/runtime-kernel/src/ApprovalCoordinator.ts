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
  private readonly pending = new Map<string, PendingApprovalResolution>();

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
    const pending = this.createPending(request);
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
      const candidate = await raceApprovalResolution(
        [
          this.approvals.waitForDecision({
            runId: run.id,
            runAttemptId,
            turnId: turn.id,
            request,
            signal,
          }),
          pending.resolution.then((outcome) => {
            if (outcome.status === "failed") throw outcome.error;
            return outcome.resolution;
          }),
        ],
        signal,
      );
      const resolution = await this.settle(
        request.approvalId,
        pending,
        candidate,
      );
      if (resolution.timedOut) {
        throw new RuntimeKernelError(
          "approval_timed_out",
          `Approval ${request.approvalId} timed out before a decision was recorded.`,
        );
      }
      if (resolution.decision === "cancelled") {
        throw new RuntimeKernelError(
          "turn_cancelled",
          `Approval ${request.approvalId} was cancelled by the user.`,
        );
      }
      if (resolution.decision === "denied") {
        throw new RuntimeKernelError(
          "approval_denied",
          "The user denied this action, so it was not executed. Do not repeat it or bypass the permission policy. Continue with permitted work, or explain what is blocked.",
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
   * callers authorize the decision first, then RuntimeKernel appends
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
    if (
      pending.settlement &&
      !sameResolution(pending.settlement.resolution, resolution)
    ) {
      throw new RuntimeKernelError(
        "approval_already_active",
        `Approval ${approvalId} already has a different decision`,
      );
    }
    try {
      const winner = await this.settle(approvalId, pending, resolution);
      pending.resolve({ status: "decided", resolution: winner });
    } catch (error) {
      // Wake the tool loop into kernel failure handling if canonical append fails.
      if (pending.settlement) pending.resolve({ status: "failed", error });
      throw error;
    }
  }

  private createPending(
    request: ApprovalRequestedPayload,
  ): PendingApprovalResolution {
    const approvalId = request.approvalId;
    const existing = this.pending.get(approvalId);
    if (existing) {
      throw new RuntimeKernelError(
        "approval_already_active",
        `Approval ${approvalId} is already active in this runtime kernel`,
      );
    }
    let resolve!: (outcome: ApprovalOutcome) => void;
    const resolution = new Promise<ApprovalOutcome>((accept) => {
      resolve = accept;
    });
    const pending: PendingApprovalResolution = {
      resolution,
      resolve,
      request,
      settlement: null,
    };
    this.pending.set(approvalId, pending);
    return pending;
  }

  private async settle(
    approvalId: ApprovalRequestedPayload["approvalId"],
    pending: PendingApprovalResolution,
    resolution: ApprovalResolution,
  ): Promise<ApprovalResolution> {
    if (pending.settlement) {
      await pending.settlement.completion;
      return pending.settlement.resolution;
    }
    if (resolution.grantScope) {
      if (resolution.decision !== "approved" || resolution.timedOut) {
        throw new RuntimeKernelError(
          "invalid_approval_grant_scope",
          "A reusable approval scope requires an approved decision.",
        );
      }
      if (
        !pending.request.options.some(
          (option) => option.id === "allow_matching_in_chat",
        )
      ) {
        throw new RuntimeKernelError(
          "invalid_approval_grant_scope",
          "The approval request did not offer matching-in-chat permission.",
        );
      }
    }
    // Claim one immutable winner before lifecycle I/O or another decision can run.
    const winner = Object.freeze({ ...resolution });
    pending.settlement = {
      resolution: winner,
      completion: Promise.resolve().then(() =>
        this.lifecycle.decideApproval(
          approvalId,
          winner.timedOut ? "timed_out" : winner.decision,
          {
            decidedBy: winner.decidedBy,
            reason: winner.reason,
            ...(winner.decision === "approved" &&
            !winner.timedOut &&
            winner.grantScope
              ? { grantScope: winner.grantScope }
              : {}),
          },
        ),
      ),
    };
    await pending.settlement.completion;
    return winner;
  }
}

type ApprovalOutcome =
  | { readonly status: "decided"; readonly resolution: ApprovalResolution }
  | { readonly status: "failed"; readonly error: unknown };

interface PendingApprovalResolution {
  readonly resolution: Promise<ApprovalOutcome>;
  readonly resolve: (outcome: ApprovalOutcome) => void;
  readonly request: ApprovalRequestedPayload;
  settlement: {
    readonly resolution: ApprovalResolution;
    readonly completion: Promise<void>;
  } | null;
}

function sameResolution(
  left: ApprovalResolution,
  right: ApprovalResolution,
): boolean {
  return (
    left.decision === right.decision &&
    left.decidedBy === right.decidedBy &&
    left.reason === right.reason &&
    Boolean(left.timedOut) === Boolean(right.timedOut) &&
    left.grantScope === right.grantScope
  );
}

function raceApprovalResolution(
  resolutions: readonly Promise<ApprovalResolution>[],
  signal?: AbortSignal,
): Promise<ApprovalResolution> {
  if (!signal) return Promise.race(resolutions);
  return new Promise<ApprovalResolution>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(
        new RuntimeKernelError("turn_cancelled", "Turn cancelled by user."),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    Promise.race(resolutions)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    // Attach contender rejection handlers even if Stop arrived during request append.
    if (signal.aborted) abort();
  });
}
