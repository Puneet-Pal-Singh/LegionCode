import type { DelegatedHarnessPort } from "@repo/runtime-kernel";
import type { HarnessSession } from "@repo/worker-protocol";
import type { HarnessRecoveryInput } from "./HarnessSessionManager.js";
import { HarnessSessionManager } from "./HarnessSessionManager.js";

/** The local App Server and authenticated cloud bridge compose the same host implementation. */
export class HarnessExecutionPort implements DelegatedHarnessPort {
  constructor(private readonly sessions: HarnessSessionManager) {}
  /** Composition invokes this before the kernel open/rebind step. */
  reconcilePriorGeneration(input: HarnessRecoveryInput) {
    return this.sessions.reconcilePriorGeneration(input);
  }
  open(
    input: Parameters<DelegatedHarnessPort["open"]>[0],
  ): ReturnType<DelegatedHarnessPort["open"]> {
    return this.sessions.open(input);
  }
  execute(
    input: Parameters<DelegatedHarnessPort["execute"]>[0],
  ): ReturnType<DelegatedHarnessPort["execute"]> {
    return this.sessions.execute(input);
  }
  observeExisting(
    input: Parameters<DelegatedHarnessPort["observeExisting"]>[0],
  ): ReturnType<DelegatedHarnessPort["observeExisting"]> {
    return this.sessions.observeExisting(input);
  }
  control(
    command: Parameters<DelegatedHarnessPort["control"]>[0],
  ): ReturnType<DelegatedHarnessPort["control"]> {
    return this.sessions.control(command);
  }
  awaitQuiescence(
    input: Parameters<DelegatedHarnessPort["awaitQuiescence"]>[0],
  ): ReturnType<DelegatedHarnessPort["awaitQuiescence"]> {
    return this.sessions.awaitQuiescence(input);
  }
  /** LOCAL calls only after canonical terminal and immutable artifact settlement.
   * Resolves after the manager verifies observation integrity, quiescence,
   * journal ACK drain, process cleanup, canonical journal settlement and detach.
   * This does not retire a durable binding or release the workspace lease;
   * those owners act only after this succeeds for the exact session generation.
   */
  releaseAfterCanonicalSettlement(session: HarnessSession): Promise<void> {
    return this.sessions.release(session);
  }
}
