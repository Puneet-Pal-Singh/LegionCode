import type { LocalPersistence } from "@repo/event-store/local";
import { RuntimeLifecycleCoordinator } from "@repo/runtime-kernel";

/** Reopen the existing admission/binding authorities without ever opening a
 * driver or resending a prompt. Unknown physical work retains its durable lease.
 */
export async function reconcileLocalHarnessRestart(persistence: LocalPersistence): Promise<void> {
  const events = await persistence.events.listAll();
  for (const event of events) {
    if (event.type !== "turn.started") continue;
    const admission = await persistence.turnAdmissions.getByTurn(event.payload.turn.id);
    if (!admission || admission.run.harnessSelection?.selection == null) continue;
    const binding = await persistence.harnessBindings.read({
      userId: admission.run.userId, turnId: admission.turn.id, runAttemptId: admission.runAttemptId,
    });
    if (binding) {
      // A claimed process may have survived the AppServer. The same writer
      // fences the exact claim; terminal replay is handled by that authority.
      // Absence of an attachment does not prove that open never happened.
      await persistence.harnessBindings.markRecoveryRequired({
        selection: binding.selection, claimId: admission.runAttemptId,
      });
      continue;
    }
    const history = await persistence.lifecycleEvents.replay({
      turnId: admission.turn.id, afterSequence: null, limit: 1,
    });
    if (history.events.length > 0) continue;
    // A missing frozen claim plus zero lifecycle history proves this local
    // admission never reached host construction. Settle through the canonical
    // runtime append path; do not manufacture review artifacts or a retry.
    const lifecycle = new RuntimeLifecycleCoordinator({
      threadId: admission.run.threadId, workspaceId: admission.run.workspaceId,
      turnId: admission.turn.id, runAttemptId: admission.runAttemptId,
      producerId: admission.run.workerId, sink: persistence.lifecycleEvents,
      executionCapability: admission.run.executionCapability,
      clock: { now: () => new Date().toISOString() },
    });
    await lifecycle.start();
    await lifecycle.interrupt("Local App Server restarted before execution was claimed");
  }
}
