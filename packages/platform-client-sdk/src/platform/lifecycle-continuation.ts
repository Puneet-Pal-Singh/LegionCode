import type { LifecycleEvent } from "@repo/platform-protocol";
import {
  LifecycleContinuationError,
  createLifecycleOrderingState,
} from "./lifecycle-ordering.js";
import type {
  AttachLifecycleStreamRequest,
  FollowLifecycleRequest,
  ReplayLifecycleEventsRequest,
  ReplayLifecycleEventsResponse,
} from "./lifecycle-types.js";

interface LifecycleContinuationInput {
  readonly request: FollowLifecycleRequest;
  replay(
    request: ReplayLifecycleEventsRequest,
  ): Promise<ReplayLifecycleEventsResponse>;
  attach(request: AttachLifecycleStreamRequest): AsyncIterable<LifecycleEvent>;
}

export async function* followLifecycleEvents(
  input: LifecycleContinuationInput,
): AsyncIterable<LifecycleEvent> {
  const state = createLifecycleOrderingState(
    input.request.turnId,
    input.request.afterSequence ?? null,
  );
  yield* replayDurableEvents(input, state);
  yield* attachLiveEvents(input, state);
}

async function* replayDurableEvents(
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
    });
    for (const event of response.events) {
      if (state.accept(event)) {
        yield event;
      }
    }
    if (!shouldReplayNextPage(response, limit, previousSequence, state)) {
      return;
    }
  }
}

async function* attachLiveEvents(
  input: LifecycleContinuationInput,
  state: ReturnType<typeof createLifecycleOrderingState>,
): AsyncIterable<LifecycleEvent> {
  const stream = input.attach({
    turnId: input.request.turnId,
    afterSequence: state.lastSequence,
  });
  for await (const event of stream) {
    if (state.accept(event)) {
      yield event;
    }
  }
}

function shouldReplayNextPage(
  response: ReplayLifecycleEventsResponse,
  limit: number | undefined,
  previousSequence: number,
  state: ReturnType<typeof createLifecycleOrderingState>,
): boolean {
  if (limit === undefined || response.events.length < limit) {
    return false;
  }
  if (state.lastSequence > previousSequence) {
    return true;
  }
  throw new LifecycleContinuationError(
    "lifecycle_sequence_regression",
    "Lifecycle replay page did not advance the sequence cursor",
    state.lastSequence + 1,
    response.nextSequence,
  );
}
