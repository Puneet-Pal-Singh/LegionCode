import type { TurnAdmissionRecord } from "@repo/persistence";
import type { LifecycleEvent } from "@repo/platform-protocol";

type Reconciliation =
  | { readonly status: "requested" }
  | { readonly status: "superseded" }
  | { readonly status: "settled"; readonly terminalEvent: LifecycleEvent };
type PersistedStopReceipt =
  | { readonly status: "interrupt_requested" }
  | { readonly status: "settled"; readonly terminalEvent: LifecycleEvent };

/** Called only AFTER the exact Stop command is durably committed. This owner
 * has read/recovery ports only: it cannot append a terminal or release resources. */
export async function acknowledgePersistedNativeStop(input: {
  readonly admission: TurnAdmissionRecord;
  readonly hasActiveOriginal: () => boolean;
  readonly requestOriginalStop: () => Promise<boolean>;
  readonly hasQueuedOrActiveRun: () => boolean;
  readonly underRunLock: (operation: () => Promise<Reconciliation>) => Promise<Reconciliation>;
  readonly readAdmission: () => Promise<TurnAdmissionRecord | null>;
  readonly readTerminal: () => Promise<LifecycleEvent | undefined>;
  readonly markRecoveryRequired: (current: TurnAdmissionRecord) => Promise<boolean>;
  readonly reportUnresolved: () => void;
}): Promise<PersistedStopReceipt> {
  const reportUnresolved = () => {
    try { input.reportUnresolved(); }
    catch { console.warn("[run/interrupt] Persisted Stop diagnostic unavailable"); }
  };
  try {
    if (input.hasActiveOriginal() && await input.requestOriginalStop())
      return { status: "interrupt_requested" };
    // The actual queued startup observes the saved Stop before any effects.
    if (input.hasQueuedOrActiveRun()) return { status: "interrupt_requested" };
    const observation = await input.underRunLock(async () => {
      const current = await input.readAdmission();
      if (!sameAdmissionIdentity(input.admission, current)) return { status: "superseded" };
      const terminal = await input.readTerminal();
      if (terminal) return { status: "settled", terminalEvent: terminal };
      if (input.hasActiveOriginal() && await input.requestOriginalStop()) return { status: "requested" };
      // Registry/history absence cannot prove original provider or resource
      // closure. Preserve its claim and record uncertainty in the same PG row.
      if (await input.markRecoveryRequired(current)) return { status: "requested" };
      const afterConflict = await input.readTerminal();
      return afterConflict
        ? { status: "settled", terminalEvent: afterConflict }
        : { status: "superseded" };
    });
    if (observation.status === "settled") return observation;
    if (observation.status === "superseded") reportUnresolved();
  } catch {
    // Downstream availability cannot invalidate the already-persisted command.
    reportUnresolved();
  }
  return { status: "interrupt_requested" };
}

function sameAdmissionIdentity(
  original: TurnAdmissionRecord,
  current: TurnAdmissionRecord | null,
): current is TurnAdmissionRecord {
  return Boolean(
    current &&
      current.userId === original.userId &&
      current.sessionId === original.sessionId &&
      current.clientMessageId === original.clientMessageId &&
      current.threadId === original.threadId &&
      current.turnId === original.turnId &&
      current.runAttemptId === original.runAttemptId &&
      current.runId === original.runId &&
      current.workspaceId === original.workspaceId &&
      current.revisionOfTurnId === original.revisionOfTurnId &&
      current.continuationOfTurnId === original.continuationOfTurnId &&
      current.originalPromptId === original.originalPromptId &&
      current.continuationTerminalSequence ===
        original.continuationTerminalSequence,
  );
}
