import {
  RunAttemptIdSchema,
  RunIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  type InterruptTurnResponse,
  type LifecycleEvent,
} from "@repo/platform-protocol";
import type { ConversationScope } from "./conversation-scope.js";
import type { PlatformClient } from "./types.js";

/** Request Stop and observe only the reserved attempt's canonical settlement. */
export async function interruptAndAwaitTerminal(
  lifecycleClient: Pick<PlatformClient, "interruptTurn" | "followTurnLifecycle">,
  scope: ConversationScope,
  onInterruptAccepted: () => void,
): Promise<void> {
  const settlementAbort = new AbortController();
  const settlementTimeout = setTimeout(
    () =>
      settlementAbort.abort(
        "Timed out waiting for interrupted terminal event.",
      ),
    15_000,
  );
  let iterator: AsyncIterator<
    LifecycleEvent
  > | null = null;
  try {
    const response = await requestExactInterrupt(
      lifecycleClient,
      scope,
      settlementAbort.signal,
    );
    // The runtime command is now durably admitted. Stop the chat transport
    // immediately so the composer reflects the user's hard-stop action while
    // lifecycle continuation independently waits for canonical settlement.
    const terminalAlreadySettled = isExactTerminalEvent(
      response.terminalEvent,
      scope,
    );
    if (response.accepted || terminalAlreadySettled) onInterruptAccepted();
    if (terminalAlreadySettled) return;
    const events = lifecycleClient.followTurnLifecycle(
      { turnId: TurnIdSchema.parse(scope.turnId) },
      { signal: settlementAbort.signal },
    );
    iterator = events[Symbol.asyncIterator]();
    while (true) {
      const next = await raceWithAbort(iterator.next(), settlementAbort.signal);
      if (next.done) break;
      const event = next.value;
      if (
        event.type === "turn.completed" ||
        event.type === "turn.failed" ||
        event.type === "turn.interrupted"
      ) {
        if (isExactTerminalEvent(event, scope)) return;
      }
    }
    throw new Error(
      "The exact reserved turn did not produce a canonical terminal event.",
    );
  } finally {
    clearTimeout(settlementTimeout);
    settlementAbort.abort("Turn interruption settlement ended.");
    if (iterator?.return) {
      void Promise.resolve(iterator.return()).catch(() => undefined);
    }
  }
}

async function requestExactInterrupt(
  lifecycleClient: Pick<PlatformClient, "interruptTurn">,
  scope: ConversationScope,
  signal: AbortSignal,
): Promise<InterruptTurnResponse> {
  const response = await raceWithAbort(
    lifecycleClient.interruptTurn(
      {
        runId: RunIdSchema.parse(scope.runId),
        workspaceId: scope.workspaceId,
        sessionId: scope.sessionId,
        threadId: ThreadIdSchema.parse(scope.threadId),
        turnId: TurnIdSchema.parse(scope.turnId),
        runAttemptId: RunAttemptIdSchema.parse(scope.runAttemptId),
        reason: "User stopped the turn.",
      },
      { signal },
    ),
    signal,
  );
  if (response.runId !== scope.runId) {
    throw new Error("The interrupt response did not match the requested run.");
  }
  if (
    !response.accepted &&
    !isExactTerminalEvent(response.terminalEvent, scope)
  ) {
    throw new Error("The runtime did not accept the interrupt request.");
  }
  return response;
}

function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error("Turn interruption settlement timed out."));
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(new Error("Turn interruption settlement timed out."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function isExactTerminalEvent(
  event: LifecycleEvent | null | undefined,
  scope: ConversationScope,
): boolean {
  return Boolean(
    event &&
    (event.type === "turn.completed" ||
      event.type === "turn.failed" ||
      event.type === "turn.interrupted") &&
    event.threadId === scope.threadId &&
    event.turnId === scope.turnId &&
    event.runAttemptId === scope.runAttemptId,
  );
}
