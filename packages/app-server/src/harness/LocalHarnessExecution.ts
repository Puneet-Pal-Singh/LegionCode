import type { LocalPersistence } from "@repo/event-store/local";
import type { DelegatedHarnessPort } from "@repo/runtime-kernel";

/** Bind a learned external identity to the already claimed local attempt before
 * the kernel can execute its prompt or acknowledge any observation. Node drivers
 * never acquire a persistence authority of their own.
 */
export class LocalHarnessExecution implements DelegatedHarnessPort {
  constructor(
    private readonly persistence: LocalPersistence,
    private readonly harness: DelegatedHarnessPort,
  ) {}

  async open(input: Parameters<DelegatedHarnessPort["open"]>[0]) {
    const session = await this.harness.open(input);
    const selection = input.command.selection;
    try {
      await this.persistence.harnessBindings.attach({
        selection: {
          userId: selection.userId, sessionId: selection.threadId, runId: selection.runId,
          workspaceId: selection.workspaceId, threadId: selection.threadId, turnId: selection.turnId,
          runAttemptId: selection.runAttemptId, selectionJson: JSON.stringify(selection),
        },
        origin: {
          instanceId: session.instanceId, externalSessionId: session.externalSessionId,
          processGeneration: session.processGeneration, authOwnerGeneration: selection.authOwnerGeneration,
        },
        expectedProcessGeneration: null,
      });
      return session;
    } catch (error) {
      // Identity creation may already have started a process. A failed/ambiguous
      // attach cannot dispatch the prompt; Stop is cleanup, never settlement.
      // The canonical kernel/lease retains ownership if cleanup is unproven.
      await this.harness.control({ kind: "interrupt", commandId: `${selection.runAttemptId}:attach-failed`, session });
      await this.harness.awaitQuiescence({ session, timeoutMs: 5_000 });
      throw error;
    }
  }

  execute(input: Parameters<DelegatedHarnessPort["execute"]>[0]) {
    return this.harness.execute(input);
  }
  observeExisting(input: Parameters<DelegatedHarnessPort["observeExisting"]>[0]) {
    return this.harness.observeExisting(input);
  }
  control(input: Parameters<DelegatedHarnessPort["control"]>[0]) {
    return this.harness.control(input);
  }
  awaitQuiescence(input: Parameters<DelegatedHarnessPort["awaitQuiescence"]>[0]) {
    return this.harness.awaitQuiescence(input);
  }
}
