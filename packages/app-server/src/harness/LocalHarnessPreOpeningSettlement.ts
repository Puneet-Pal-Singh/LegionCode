import type { LocalPersistence } from "@repo/event-store/local";
import type { LifecycleEvent, TurnAdmission } from "@repo/platform-protocol";
import { RuntimeLifecycleCoordinator } from "@repo/runtime-kernel";

/** Called only by the original physical owner's sealed no-dispatch path.
 * This appends canonical interruption; it grants no physical closure authority. */
export async function settleLocalHarnessBeforeDispatch(
  persistence: LocalPersistence, admission: TurnAdmission, outcome: "failed" | "interrupted" = "interrupted",
): Promise<void> {
  const history: LifecycleEvent[] = [];
  let afterSequence: number | null = null;
  for (let page = 0; ; page += 1) {
    if (page === 100) throw new Error("Pre-opening replay exceeds its recovery bound");
    const replay = await persistence.lifecycleEvents.replay({ turnId: admission.turn.id, afterSequence, limit: 1000 });
    for (const event of replay.events) {
      if (event.turnId !== admission.turn.id || event.threadId !== admission.run.threadId ||
          event.workspaceId !== admission.run.workspaceId || event.runAttemptId !== admission.runAttemptId ||
          event.producer.id !== admission.run.workerId || event.sequence !== history.length + 1) {
        throw new Error("Pre-opening replay differs from the admitted attempt");
      }
      history.push(event);
    }
    if (replay.nextSequence === null) break;
    if (!replay.events.length || replay.nextSequence !== history.at(-1)?.sequence ||
        replay.nextSequence <= (afterSequence ?? 0)) throw new Error("Pre-opening replay did not advance");
    afterSequence = replay.nextSequence;
  }
  const terminal = history.at(-1);
  if (terminal?.type === "turn.failed" || terminal?.type === "turn.interrupted") return;
  if (history.some((event) => ["turn.completed", "turn.failed", "turn.interrupted"].includes(event.type))) {
    throw new Error("Pre-opening history has incompatible terminal evidence");
  }
  const lifecycle = new RuntimeLifecycleCoordinator({
    threadId: admission.run.threadId, workspaceId: admission.run.workspaceId,
    turnId: admission.turn.id, runAttemptId: admission.runAttemptId,
    producerId: admission.run.workerId, sink: persistence.lifecycleEvents,
    executionCapability: admission.run.executionCapability,
    clock: { now: () => new Date().toISOString() },
  });
  if (history.length) await lifecycle.restoreHarnessHistory(history);
  else await lifecycle.start();
  if (outcome === "interrupted") await lifecycle.interrupt("Local preparation settled before external execution");
  else await lifecycle.fail({ code: "internal_error", message: "Local runtime preparation failed",
    retryable: false, correlationId: null, details: null });
}
