import type { LifecycleEventStore } from "@repo/event-store";
import { LifecycleEventSchema, TurnDiffPayloadSchema, type LifecycleEvent, type TurnAdmission, type TurnDiffPayload } from "@repo/platform-protocol";
import { AppServerOperationError } from "./server.js";

type TerminalEvent = Extract<LifecycleEvent, { type: "turn.completed" | "turn.failed" | "turn.interrupted" }>;

/** Canonical Native publication facts shared by saved review and resource receipts.
 * This read grants no execution, lease or resource-release authority. */
export async function readLocalTurnArtifactPublication(
  lifecycleEvents: LifecycleEventStore,
  admission: TurnAdmission,
): Promise<{ readonly terminal: TerminalEvent | null; readonly diff: TurnDiffPayload | null }> {
  let afterSequence: number | null = null;
  let sequence = 0;
  let terminal: TerminalEvent | null = null;
  let diff: TurnDiffPayload | null = null;
  const starts = ["turn.queued", "turn.started", "run_attempt.started"];
  do {
    const page = await lifecycleEvents.replay({
      turnId: admission.turn.id,
      afterSequence,
      limit: 1_000,
    });
    for (const raw of page.events) {
      const event = LifecycleEventSchema.parse(raw);
      if (
        terminal ||
        event.turnId !== admission.turn.id ||
        event.threadId !== admission.run.threadId ||
        event.runAttemptId !== admission.runAttemptId ||
        event.producer.id !== admission.run.workerId ||
        event.sequence !== sequence + 1 ||
        (sequence < starts.length && event.type !== starts[sequence]) ||
        (sequence >= starts.length && starts.includes(event.type))
      )
        throw unavailable();
      sequence = event.sequence;
      if (event.type === "turn.diff_updated") {
        diff = TurnDiffPayloadSchema.parse(event.payload.diff);
        if (diff.turnId !== admission.turn.id) throw unavailable();
      }
      if (event.type === "workspace.snapshot_unavailable") diff = null;
      if (
        event.type === "turn.completed" ||
        event.type === "turn.failed" ||
        event.type === "turn.interrupted"
      ) {
        terminal = event;
      }
    }
    if (
      page.nextSequence !== null &&
      (page.events.length === 0 ||
        page.nextSequence !== sequence ||
        page.nextSequence <= (afterSequence ?? 0))
    )
      throw unavailable();
    afterSequence = page.nextSequence;
  } while (afterSequence !== null);
  // Persisted bytes alone are not publication. In-progress, omitted or
  // unavailable capture remains an honest null, without consulting live Git.
  return { terminal, diff: terminal ? diff : null };
}

function unavailable(): AppServerOperationError {
  return new AppServerOperationError(503, "server_unavailable", "Saved turn review could not be verified");
}
