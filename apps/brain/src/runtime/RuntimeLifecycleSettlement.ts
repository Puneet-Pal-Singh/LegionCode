import type { LifecycleEventStore } from "@repo/persistence";
import type { TurnAdmissionRecord } from "@repo/persistence";
import type {
  LifecycleEvent,
  ProtocolError,
  RunAttemptId,
  ThreadId,
  TurnId,
  WorkspaceId,
} from "@repo/platform-protocol";
import { RuntimeLifecycleCoordinator } from "@repo/runtime-kernel";

export interface RuntimeLifecycleSettlementIdentity {
  readonly turnId: TurnId;
  readonly runAttemptId: RunAttemptId;
  readonly threadId: ThreadId;
  readonly workspaceId: WorkspaceId;
  readonly revisionOfTurnId?: TurnId;
  readonly continuationOfTurnId?: TurnId;
  readonly originalPromptId?: string;
}

export interface OwnedStartupFailureIdentity extends RuntimeLifecycleSettlementIdentity {
  readonly admittedWorkspaceId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly correlationId: string;
}

export type RuntimeLifecycleSettlementResult =
  | { readonly status: "settled"; readonly terminalEvent: LifecycleEvent }
  | { readonly status: "history_exists" }
  | {
      readonly status: "terminal_exists";
      readonly terminalEvent: LifecycleEvent;
    }
  | { readonly status: "append_conflict" };

export async function settleOwnedStartupFailure(input: {
  readonly store: LifecycleEventStore;
  readonly claim: { readonly turnId: TurnId; readonly claimId: string };
  readonly identity: OwnedStartupFailureIdentity;
  readonly markRecoveryRequired: (claim: {
    readonly turnId: TurnId;
    readonly claimId: string;
  }) => Promise<boolean>;
  readonly readAdmission: () => Promise<TurnAdmissionRecord | null>;
  readonly interruptReason: string | null;
  readonly failure: ProtocolError;
}): Promise<
  RuntimeLifecycleSettlementResult | { readonly status: "not_owned" }
> {
  if (
    input.claim.turnId !== input.identity.turnId ||
    !(await input.markRecoveryRequired(input.claim))
  ) {
    return { status: "not_owned" };
  }
  const admission = await input.readAdmission();
  if (
    admission?.state !== "admitted" ||
    admission.executionState !== "recovery_required" ||
    admission.userId !== input.identity.userId ||
    admission.sessionId !== input.identity.sessionId ||
    admission.runId !== input.identity.runId ||
    admission.turnId !== input.identity.turnId ||
    admission.runAttemptId !== input.identity.runAttemptId ||
    admission.threadId !== input.identity.threadId ||
    admission.workspaceId !== input.identity.admittedWorkspaceId ||
    admission.revisionOfTurnId !== (input.identity.revisionOfTurnId ?? null) ||
    admission.continuationOfTurnId !==
      (input.identity.continuationOfTurnId ?? null) ||
    admission.originalPromptId !== (input.identity.originalPromptId ?? null)
  ) {
    return { status: "not_owned" };
  }

  return await settleEmptyRuntimeLifecycle({
    store: input.store,
    identity: {
      turnId: input.identity.turnId,
      runAttemptId: input.identity.runAttemptId,
      threadId: input.identity.threadId,
      workspaceId: input.identity.workspaceId,
      ...(input.identity.revisionOfTurnId
        ? { revisionOfTurnId: input.identity.revisionOfTurnId }
        : {}),
      ...(input.identity.continuationOfTurnId
        ? { continuationOfTurnId: input.identity.continuationOfTurnId }
        : {}),
      ...(input.identity.originalPromptId
        ? { originalPromptId: input.identity.originalPromptId }
        : {}),
    },
    outcome: input.interruptReason
      ? { type: "interrupted", reason: input.interruptReason }
      : {
          type: "failed",
          failure: input.failure,
        },
  });
}

export async function settleOrphanStop(input: {
  readonly store: LifecycleEventStore;
  readonly admission: TurnAdmissionRecord;
  readonly identity: RuntimeLifecycleSettlementIdentity;
  readonly admittedWorkspaceId: string;
  readonly reason: string;
}): Promise<
  | RuntimeLifecycleSettlementResult
  | { readonly status: "not_recovery_orphan" }
  | { readonly status: "not_recoverable" }
> {
  if (
    input.admission.state !== "admitted" ||
    (input.admission.executionState !== "running" &&
      input.admission.executionState !== "recovery_required") ||
    input.admission.turnId !== input.identity.turnId ||
    input.admission.runAttemptId !== input.identity.runAttemptId ||
    input.admission.threadId !== input.identity.threadId ||
    input.admission.workspaceId !== input.admittedWorkspaceId ||
    input.admission.revisionOfTurnId !==
      (input.identity.revisionOfTurnId ?? null) ||
    input.admission.continuationOfTurnId !==
      (input.identity.continuationOfTurnId ?? null) ||
    input.admission.originalPromptId !==
      (input.identity.originalPromptId ?? null)
  ) {
    return { status: "not_recovery_orphan" };
  }
  const history = await readLifecycleHistory(
    input.store,
    input.identity.turnId,
  );
  const terminalEvent = history.find(isTerminalEvent);
  if (terminalEvent) {
    return { status: "terminal_exists", terminalEvent };
  }
  if (history.length === 0) {
    return await settleEmptyRuntimeLifecycle({
      store: input.store,
      identity: input.identity,
      outcome: { type: "interrupted", reason: input.reason },
    });
  }

  const constructedEvents: LifecycleEvent[] = [];
  try {
    const coordinator = RuntimeLifecycleCoordinator.restoreForInterruption(
      {
        ...input.identity,
        sink: {
          appendBatch: async (events) => {
            constructedEvents.push(...events);
            return events;
          },
        },
        producerId: "brain-runtime-recovery",
        clock: { now: () => new Date().toISOString() },
      },
      history,
    );
    await coordinator.interrupt(input.reason);
  } catch {
    return { status: "not_recoverable" };
  }

  try {
    await input.store.appendBatch(constructedEvents);
  } catch {
    const afterConflict = await readLifecycleHistory(
      input.store,
      input.identity.turnId,
    );
    const terminalAfterConflict = afterConflict.find(isTerminalEvent);
    return terminalAfterConflict
      ? { status: "terminal_exists", terminalEvent: terminalAfterConflict }
      : { status: "history_exists" };
  }

  const settledHistory = await readLifecycleHistory(
    input.store,
    input.identity.turnId,
  );
  const settledTerminal = settledHistory.find(isTerminalEvent);
  return settledTerminal
    ? { status: "settled", terminalEvent: settledTerminal }
    : { status: "append_conflict" };
}

/**
 * Settles only turns with no lifecycle history. The append path and its
 * persistence transaction remain the sole authority for terminal state.
 */
export async function settleEmptyRuntimeLifecycle(input: {
  readonly store: LifecycleEventStore;
  readonly identity: RuntimeLifecycleSettlementIdentity;
  readonly outcome:
    | { readonly type: "failed"; readonly failure: ProtocolError }
    | { readonly type: "interrupted"; readonly reason: string };
}): Promise<RuntimeLifecycleSettlementResult> {
  const existingHistory = await readLifecycleHistory(
    input.store,
    input.identity.turnId,
  );
  if (existingHistory.length > 0) {
    const terminalEvent = existingHistory.find(isTerminalEvent);
    return terminalEvent
      ? { status: "terminal_exists", terminalEvent }
      : { status: "history_exists" };
  }

  const constructedEvents: LifecycleEvent[] = [];
  const collectingSink = {
    appendBatch: async (events: readonly LifecycleEvent[]) => {
      constructedEvents.push(...events);
      return events;
    },
  };
  const coordinator = new RuntimeLifecycleCoordinator({
    ...input.identity,
    sink: collectingSink,
    producerId: "brain-runtime-recovery",
    clock: { now: () => new Date().toISOString() },
    initialSequence: 0,
  });

  try {
    await coordinator.start();
    if (input.outcome.type === "failed") {
      await coordinator.fail(input.outcome.failure);
    } else {
      await coordinator.interrupt(input.outcome.reason);
    }
    await input.store.appendBatch(constructedEvents);
  } catch {
    const afterConflict = await readLifecycleHistory(
      input.store,
      input.identity.turnId,
    );
    const terminalEvent = afterConflict.find(isTerminalEvent);
    if (terminalEvent) {
      return { status: "terminal_exists", terminalEvent };
    }
    if (afterConflict.length > 0) {
      return { status: "history_exists" };
    }
    return { status: "append_conflict" };
  }

  const terminalHistory = await readLifecycleHistory(
    input.store,
    input.identity.turnId,
  );
  const terminalEvent = terminalHistory.find(isTerminalEvent);
  return terminalEvent
    ? { status: "settled", terminalEvent }
    : { status: "append_conflict" };
}

async function readLifecycleHistory(
  store: LifecycleEventStore,
  turnId: TurnId,
): Promise<LifecycleEvent[]> {
  const events: LifecycleEvent[] = [];
  let afterSequence: number | null = null;
  for (;;) {
    const replay = await store.replay({ turnId, afterSequence, limit: 1_000 });
    events.push(...replay.events);
    if (replay.events.length < 1_000 || replay.nextSequence === null) {
      return events;
    }
    if (replay.nextSequence === afterSequence) {
      throw new Error(
        `Lifecycle replay cursor did not advance for turn ${turnId}`,
      );
    }
    afterSequence = replay.nextSequence;
  }
}

function isTerminalEvent(event: LifecycleEvent): boolean {
  return (
    event.type === "turn.completed" ||
    event.type === "turn.failed" ||
    event.type === "turn.interrupted"
  );
}
