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
          pending.resolution,
        ],
        signal,
      );
      const resolution = await this.settle(request.approvalId, pending, candidate);
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
    await this.settle(approvalId, pending, resolution, true);
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
    let resolve!: (resolution: ApprovalResolution) => void;
    const resolution = new Promise<ApprovalResolution>((accept) => {
      resolve = accept;
    });
    const pending: PendingApprovalResolution = {
      resolution,
      resolve,
      request,
      settlement: null,
      selectedResolution: null,
    };
    this.pending.set(approvalId, pending);
    return pending;
  }

  private async settle(
    approvalId: ApprovalRequestedPayload["approvalId"],
    pending: PendingApprovalResolution,
    resolution: ApprovalResolution,
    rejectConflict = false,
  ): Promise<ApprovalResolution> {
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
    if (pending.selectedResolution && rejectConflict &&
      !sameResolution(pending.selectedResolution, resolution)) {
      throw new RuntimeKernelError("approval_resolution_conflict",
        `Approval ${approvalId} already has a different winning resolution`);
    }
    // Select synchronously before the first append/await; the waiter, persistence
    // and reply path must all use this same immutable value.
    pending.selectedResolution ??= Object.freeze({ ...resolution });
    const selected = pending.selectedResolution;
    pending.settlement ??= this.lifecycle.decideApproval(
      approvalId,
      selected.timedOut ? "timed_out" : selected.decision,
      {
        decidedBy: selected.decidedBy,
        reason: selected.reason,
        ...(selected.decision === "approved" && !selected.timedOut && selected.grantScope
          ? { grantScope: selected.grantScope } : {}),
      },
    );
    await pending.settlement;
    pending.resolve(selected);
    return selected;
  }
}

interface PendingApprovalResolution {
  readonly resolution: Promise<ApprovalResolution>;
  readonly resolve: (resolution: ApprovalResolution) => void;
  readonly request: ApprovalRequestedPayload;
  settlement: Promise<void> | null;
  selectedResolution: ApprovalResolution | null;
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
      reject(
        new RuntimeKernelError("turn_cancelled", "Turn cancelled by user."),
      );
    signal.addEventListener("abort", abort, { once: true });
    Promise.race(resolutions)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

function sameResolution(a: ApprovalResolution, b: ApprovalResolution): boolean {
  return a.decision === b.decision && a.decidedBy === b.decidedBy &&
    a.reason === b.reason && Boolean(a.timedOut) === Boolean(b.timedOut) &&
    a.grantScope === b.grantScope;
}
