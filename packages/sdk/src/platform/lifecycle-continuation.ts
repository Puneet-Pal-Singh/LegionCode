import type { LifecycleEvent } from "@repo/platform-protocol";
import {
  LifecycleContinuationError,
  createLifecycleOrderingState,
} from "./lifecycle-ordering.js";
import type {
  FollowLifecycleRequest,
  ReplayLifecycleEventsRequest,
  ReplayLifecycleEventsResponse,
} from "./lifecycle-types.js";
import type { PlatformClientOperationOptions } from "./types.js";

const DEFAULT_POLL_INTERVAL_MS = 500;
const MAX_RETRY_DELAY_MS = 2_000;

const TERMINAL_EVENT_TYPES = new Set([
  "turn.completed",
  "turn.failed",
  "turn.interrupted",
]);

function isTerminalLifecycleEventType(type: string): boolean {
  return TERMINAL_EVENT_TYPES.has(type);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

function isRetryableTransportError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return false;
  }
  if (error instanceof TypeError) {
    return true;
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes("network") ||
      msg.includes("timeout") ||
      msg.includes("econnrefused") ||
      msg.includes("fetch failed") ||
      msg.includes("socket")
    );
  }
  return false;
}

interface LifecycleContinuationInput {
  readonly request: FollowLifecycleRequest;
  readonly options?: PlatformClientOperationOptions;
  replay(
    request: ReplayLifecycleEventsRequest,
    options?: PlatformClientOperationOptions,
  ): Promise<ReplayLifecycleEventsResponse>;
}

export async function* followLifecycleEvents(
  input: LifecycleContinuationInput,
): AsyncIterable<LifecycleEvent> {
  const state = createLifecycleOrderingState(
    input.request.turnId,
    input.request.afterSequence ?? null,
  );

  let terminal = false;
  for await (const event of replayPaged(input, state)) {
    yield event;
    if (isTerminalLifecycleEventType(event.type)) {
      terminal = true;
    }
  }

  if (terminal) {
    return;
  }

  yield* pollLiveEvents(input, state);
}

async function* replayPaged(
  input: LifecycleContinuationInput,
  state: ReturnType<typeof createLifecycleOrderingState>,
): AsyncIterable<LifecycleEvent> {
  const limit = input.request.replayLimit;
  while (true) {
    const previousSequence = state.lastSequence;
    const response = await input.replay({
      turnId: input.request.turnId,
      afterSequence: state.lastSequence,
      limit,
    }, input.options);
    for (const event of response.events) {
      if (state.accept(event)) {
        yield event;
      }
    }
    if (response.events.length === 0) {
      return;
    }
    if (limit === undefined || response.events.length < limit) {
      return;
    }
    if (state.lastSequence > previousSequence) {
      continue;
    }
    throw new LifecycleContinuationError(
      "lifecycle_sequence_regression",
      "Lifecycle replay page did not advance the sequence cursor",
      state.lastSequence + 1,
      response.nextSequence,
    );
  }
}

async function* pollLiveEvents(
  input: LifecycleContinuationInput,
  state: ReturnType<typeof createLifecycleOrderingState>,
): AsyncIterable<LifecycleEvent> {
  let attempt = 0;

  while (!input.options?.signal?.aborted) {
    try {
      const response = await input.replay({
        turnId: input.request.turnId,
        afterSequence: state.lastSequence,
        limit: input.request.replayLimit,
      }, input.options);

      let hasNew = false;
      for (const event of response.events) {
        if (state.accept(event)) {
          hasNew = true;
          yield event;
          if (isTerminalLifecycleEventType(event.type)) {
            return;
          }
        }
      }

      if (hasNew) {
        attempt = 0;
      }
      await delay(DEFAULT_POLL_INTERVAL_MS, input.options?.signal);
    } catch (error) {
      if (input.options?.signal?.aborted) return;
      if (isRetryableTransportError(error)) {
        attempt += 1;
        const delayMs = Math.min(
          DEFAULT_POLL_INTERVAL_MS * Math.pow(2, attempt),
          MAX_RETRY_DELAY_MS,
        );
        await delay(delayMs, input.options?.signal);
        continue;
      }
      throw error;
    }
  }
}
