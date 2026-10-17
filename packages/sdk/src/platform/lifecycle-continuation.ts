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
import { PlatformClientOperationError } from "./errors.js";

const DEFAULT_POLL_INTERVAL_MS = 500;
const MAX_RETRY_DELAY_MS = 2_000;
const NON_RETRYABLE_LIFECYCLE_ERROR_CODES = new Set([
  "ABORTED",
  "INVALID_REQUEST_CONTRACT",
  "INVALID_RESPONSE_CONTRACT",
  "INVALID_RESPONSE_FORMAT",
  "INVALID_ERROR_RESPONSE",
  "MISSING_RUN_ID",
  "unauthorized",
  "forbidden",
  "validation_failed",
  "not_found",
  "conflict",
  "model_unavailable",
  "capability_unsupported",
  "tool_unavailable_in_backend",
  "policy_denied",
  "approval_required",
  "illegal_lifecycle_transition",
  "path_denied",
  "file_not_found",
  "command_failed",
  "command_cancelled",
]);

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

export function isRetryableLifecycleTransportError(error: unknown): boolean {
  if (
    !(error instanceof PlatformClientOperationError) ||
    !error.retryable ||
    error.statusCode === 401 ||
    error.statusCode === 403 ||
    NON_RETRYABLE_LIFECYCLE_ERROR_CODES.has(error.code)
  ) {
    return false;
  }

  // Unknown server error codes can still represent transient HTTP failures.
  // The transport marks 429/5xx retryable from status, so preserve that signal
  // without treating an unknown code at an ordinary status as transient.
  if (error.code === "UNKNOWN_OPERATION_ERROR") {
    return error.statusCode === 429 || (error.statusCode ?? 0) >= 500;
  }

  return true;
}

export async function replayLifecycleEventsWithRetry(
  input: Pick<LifecycleContinuationInput, "options" | "replay">,
  request: ReplayLifecycleEventsRequest,
): Promise<ReplayLifecycleEventsResponse> {
  let attempt = 0;
  while (true) {
    if (input.options?.signal?.aborted) {
      throw new PlatformClientOperationError(
        "ABORTED",
        "Lifecycle replay was aborted",
        false,
      );
    }
    try {
      return await input.replay(request, input.options);
    } catch (error) {
      if (
        input.options?.signal?.aborted ||
        !isRetryableLifecycleTransportError(error)
      ) {
        throw error;
      }
      attempt += 1;
      input.options?.onLifecycleContinuationStatus?.("reconnecting");
      await delay(
        Math.min(DEFAULT_POLL_INTERVAL_MS * 2 ** attempt, MAX_RETRY_DELAY_MS),
        input.options?.signal,
      );
    }
  }
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
    input.options?.onLifecycleContinuationStatus?.("following");
    return;
  }

  yield* pollLiveEvents(input, state);
}

async function* replayPaged(
  input: LifecycleContinuationInput,
  state: ReturnType<typeof createLifecycleOrderingState>,
): AsyncIterable<LifecycleEvent> {
  input.options?.onLifecycleContinuationStatus?.("replaying");
  const limit = input.request.replayLimit;
  while (true) {
    const previousSequence = state.lastSequence;
    const response = await replayLifecycleEventsWithRetry(input, {
      turnId: input.request.turnId,
      afterSequence: state.lastSequence,
      limit,
    });
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
  input.options?.onLifecycleContinuationStatus?.("following");

  while (!input.options?.signal?.aborted) {
    try {
      const response = await input.replay(
        {
          turnId: input.request.turnId,
          afterSequence: state.lastSequence,
          limit: input.request.replayLimit,
        },
        input.options,
      );
      input.options?.onLifecycleContinuationStatus?.("following");

      let hasNew = false;
      for (const event of response.events) {
        if (state.accept(event)) {
          hasNew = true;
          yield event;
          if (isTerminalLifecycleEventType(event.type)) {
            input.options?.onLifecycleContinuationStatus?.("following");
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
      if (isRetryableLifecycleTransportError(error)) {
        attempt += 1;
        input.options?.onLifecycleContinuationStatus?.("reconnecting");
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
