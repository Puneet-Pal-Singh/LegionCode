import type { LocalPersistence } from "@repo/event-store/local";
import { ChatRequestBodySchema, type TurnId } from "@repo/platform-protocol";
import type { TurnAdmission } from "@repo/platform-protocol/conversation";
import type { LocalWorkspaceLease } from "./LocalWorkspaceLease.js";
import { RuntimeLifecycleCoordinator } from "@repo/runtime-kernel";

export type LocalHarnessBackend = "native" | "delegated";
export interface LocalHarnessInitializationResult {
  readonly status: "ready" | "recovery_required";
  readonly retainedTurnIds: readonly TurnId[];
}

/** Backend ownership belongs to the matching immutable admission markers. */
export function localAdmissionBackend(admission: TurnAdmission, environmentId: string): LocalHarnessBackend {
  const message = admission.userMessage;
  if (message.type !== "user_message" || message.runId !== admission.run.id ||
      message.turnId !== admission.turn.id || message.threadId !== admission.run.threadId ||
      admission.turn.runId !== admission.run.id || admission.turn.threadId !== admission.run.threadId) {
    throw new Error("Local saved turn admission identity is inconsistent");
  }
  const run = ChatRequestBodySchema.parse({ harnessSelection: admission.run.harnessSelection }).harnessSelection;
  const captured = ChatRequestBodySchema.parse({ harnessSelection: message.content.harnessSelection }).harnessSelection;
  if (run && run.environmentId !== environmentId) throw new Error("Local saved turn belongs to a different environment");
  if (JSON.stringify(run) !== JSON.stringify(captured)) throw new Error("Local saved turn backend markers disagree");
  return run?.selection == null ? "native" : "delegated";
}

/** Reopen the existing admission/binding authorities without ever opening a
 * driver or resending a prompt. Unknown physical work retains its durable lease.
 */
export async function reconcileLocalHarnessRestart(persistence: LocalPersistence, leases: Pick<LocalWorkspaceLease, "assertSettled">): Promise<LocalHarnessInitializationResult> {
  const retained = new Set<TurnId>();
  const events = await persistence.events.listAll();
  for (const event of events) {
    if (event.type !== "turn.started") continue;
    const admission = await persistence.turnAdmissions.getByTurn(event.payload.turn.id);
    if (!admission) { retained.add(event.payload.turn.id); continue; }
    try { if (localAdmissionBackend(admission, persistence.environmentId) === "native") continue; }
    catch { retained.add(admission.turn.id); continue; }
    const binding = await persistence.harnessBindings.read({
      userId: admission.run.userId, turnId: admission.turn.id, runAttemptId: admission.runAttemptId,
    });
    if (binding) {
      const proof = await persistence.readAttachmentRetirement({ userId: admission.run.userId,
        turnId: admission.turn.id, runAttemptId: admission.runAttemptId });
      if (proof.status === "verified_retirement") {
        await leases.assertSettled(admission);
        continue; // Actual durable closure: no driver open or recovery mark.
      }
      // A claimed process may have survived the AppServer. The same writer
      // fences the exact claim; terminal replay is handled by that authority.
      // Absence of an attachment does not prove that open never happened.
      retained.add(admission.turn.id);
      await persistence.harnessBindings.markRecoveryRequired({
        selection: binding.selection, claimId: admission.runAttemptId,
      });
      continue;
    }
    const history = await persistence.lifecycleEvents.replay({
      turnId: admission.turn.id, afterSequence: null, limit: 1,
    });
    if (history.events.length > 0) {
      // No frozen claim exists. The same lease authority still validates final
      // canonical/artifact evidence; terminal replay alone is not settlement.
      try { await leases.assertSettled(admission); }
      catch { retained.add(admission.turn.id); }
      continue;
    }
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
    try { await leases.assertSettled(admission); }
    catch { retained.add(admission.turn.id); }
  }
  return { status: retained.size ? "recovery_required" : "ready", retainedTurnIds: [...retained] };
}
