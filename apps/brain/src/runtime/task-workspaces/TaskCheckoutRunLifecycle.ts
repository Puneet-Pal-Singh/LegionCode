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

  constructor(
    private readonly checkoutId: TaskCheckout["checkoutId"],
    private readonly settlement: TaskCheckoutSettlementPort,
    private readonly executionSession: SecureExecutionSessionPort,
  ) {}

  get isSettled(): boolean {
    return this.settled;
  }

  async settle(outcome: TaskCheckoutTerminalOutcome): Promise<TaskCheckout> {
    if (this.settled) {
      throw new Error("Task checkout has already settled");
    }
    const checkout = await this.settlement.settleExecution(
      this.checkoutId,
      outcome,
    );
    this.settled = true;
    return checkout;
  }

  async release(): Promise<void> {
    await this.executionSession.release();
  }
}
