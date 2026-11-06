import { hasImmutableRuntimeSettlement } from "./TaskCheckoutSettlementEvidence";
import type {
  LifecycleEvent,
  TurnId,
  RunAttemptId,
} from "@repo/platform-protocol";
import type { TaskCheckout } from "@repo/platform-protocol";
import type { SecureExecutionSessionPort } from "../../services/secure-execution/SecureExecutionSessionClient";
import type { TaskCheckoutSettlementPort } from "./TaskCheckoutExecutionOrchestrator";

export type TaskCheckoutTerminalOutcome =
  | { readonly status: "settled" }
  | { readonly status: "failed"; readonly failureCode: string };

/**
 * Owns terminal settlement and lease release for one claimed checkout.
 *
 * The request handler coordinates the wider turn pipeline; this collaborator
 * prevents post-run persistence failures from leaking an active checkout and
 * keeps secure-session release idempotent at one explicit boundary.
 */
export class TaskCheckoutRunLifecycle {
  private settled = false;
  private retainedUntilLeaseExpiry = false;
  private runtimeIdentity: {
    readonly turnId: TurnId;
    readonly runAttemptId: RunAttemptId;
  } | null = null;
  private recoveryRequired = false;

  /** Called immediately before any runtime work can start, including startup hooks. */
  beginRuntimeExecution(identity: {
    readonly turnId: TurnId;
    readonly runAttemptId: RunAttemptId;
  }): void {
    if (this.runtimeIdentity)
      throw new Error("Checkout runtime ownership already started");
    this.runtimeIdentity = identity;
    this.recoveryRequired = true;
  }

  observeRuntimeSettlement(events: readonly LifecycleEvent[]): void {
    if (!this.runtimeIdentity) return;
    this.recoveryRequired = !hasImmutableRuntimeSettlement(
      events,
      this.runtimeIdentity,
    );
  }

  get requiresRecovery(): boolean {
    return this.recoveryRequired;
  }

  constructor(
    private readonly checkoutId: TaskCheckout["checkoutId"],
    private readonly settlement: TaskCheckoutSettlementPort,
    private readonly executionSession: SecureExecutionSessionPort,
  ) {}

  get isSettled(): boolean {
    return this.settled;
  }

  async settle(
    outcome: TaskCheckoutTerminalOutcome,
  ): Promise<TaskCheckout | null> {
    // Unknown mutation state keeps both active checkout ownership and its lease.
    if (this.recoveryRequired) return null;
    if (this.settled) {
      throw new Error("Task checkout has already settled");
    }
    const checkout = await this.settlement.settleExecution(
      this.checkoutId,
      outcome,
    );
    this.settled = true;
    this.retainedUntilLeaseExpiry =
      outcome.status === "settled" && checkout.status === "settled";
    return checkout;
  }

  async release(): Promise<void> {
    if (
      this.recoveryRequired ||
      (this.settled && this.retainedUntilLeaseExpiry)
    )
      return;
    await this.executionSession.release();
  }
}
