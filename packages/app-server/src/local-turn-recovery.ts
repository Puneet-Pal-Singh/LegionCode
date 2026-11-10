import type { LocalPersistence } from "@repo/event-store/local";
import type { EventCursor } from "@repo/platform-protocol";
import type { LocalTurnRuntime } from "./local-turns.js";

/** Startup only, while the sole persistence owner has accepted no commands.
 * The runtime decides supported ownership and writes canonical settlement. */
export async function reconcileLostLocalTurns(
  persistence: Pick<LocalPersistence, "turnAdmissions">,
  runtime: LocalTurnRuntime,
): Promise<void> {
  let afterCursor: EventCursor | null = null;
  for (;;) {
    const page = await persistence.turnAdmissions.listForRecovery({ afterCursor, limit: 25 });
    if (!page.admissions.length) return;
    if (page.nextCursor === null || page.nextCursor === afterCursor) {
      throw new Error("Local admission recovery cursor did not advance");
    }
    for (const admission of page.admissions) await runtime.reconcileLostTurn(admission);
    afterCursor = page.nextCursor;
  }
}
