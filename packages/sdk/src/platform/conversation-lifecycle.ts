import type { LifecycleEvent, TurnId } from "@repo/platform-protocol";
import {
  applyConversationLifecycleEvent,
  createLifecycleProjection,
  type LifecycleProjection,
} from "../workflow/conversation-lifecycle-projection.js";
import { replayLifecycleEventsWithRetry } from "./lifecycle-continuation.js";
import type { PlatformClient, PlatformClientOperationOptions } from "./types.js";

export type ConversationLifecycleContinuationStatus = Parameters<
  NonNullable<PlatformClientOperationOptions["onLifecycleContinuationStatus"]>
>[0];

export interface ConversationLifecycleProjectionBindings {
  readonly turnId: TurnId;
  readonly lifecycleClient: Pick<
    PlatformClient,
    "replayLifecycleEvents" | "followTurnLifecycle"
  >;
  readonly signal: AbortSignal;
  readonly onProjection: (projection: LifecycleProjection) => void;
  readonly onStatus: (
    status: ConversationLifecycleContinuationStatus | null,
  ) => void;
}

/** Publish a complete saved snapshot before continuing the same projection live. */
export async function followConversationLifecycleProjection(
  input: ConversationLifecycleProjectionBindings,
): Promise<void> {
  let projection = createLifecycleProjection(input.turnId);
  let afterSequence: number | null = null;
  let resumed = false;
  const resumedEvents: LifecycleEvent[] = [];
  const operationOptions: PlatformClientOperationOptions = {
    signal: input.signal,
    onLifecycleContinuationStatus: (status) => {
      if (input.signal.aborted) return;
      if (status === "following" && !resumed) {
        resumed = true;
        for (const event of resumedEvents) {
          projection = applyConversationLifecycleEvent(projection, event);
        }
        if (resumedEvents.length > 0) {
          input.onProjection(projection);
          resumedEvents.length = 0;
        }
      }
      input.onStatus(status);
    },
  };
  input.onStatus("replaying");

  // Publishing each saved event exposes obsolete intermediate state such as an
  // approval request resolved later in that same snapshot. Publish only once.
  while (!input.signal.aborted) {
    const replay = await replayLifecycleEventsWithRetry(
      {
        options: operationOptions,
        replay: (request, options) =>
          input.lifecycleClient.replayLifecycleEvents(request, options),
      },
      { turnId: input.turnId, afterSequence, limit: 1_000 },
    );
    for (const event of replay.events) {
      projection = applyConversationLifecycleEvent(projection, event);
    }
    if (replay.events.length < 1_000 || replay.nextSequence === null) break;
    afterSequence = projection.lastSequence || null;
  }

  if (input.signal.aborted) return;
  input.onProjection(projection);
  if (projection.terminal) {
    input.onStatus(null);
    return;
  }

  for await (const event of input.lifecycleClient.followTurnLifecycle(
    { turnId: input.turnId, afterSequence: projection.lastSequence || null },
    operationOptions,
  )) {
    if (input.signal.aborted) return;
    if (!resumed) {
      resumedEvents.push(event);
      continue;
    }
    projection = applyConversationLifecycleEvent(projection, event);
    input.onProjection(projection);
  }
  if (projection.terminal) input.onStatus(null);
}

/** Replay historical turns without turning an unsettled old turn into a poller. */
export async function replayConversationLifecycleProjection(input: {
  readonly turnId: TurnId;
  readonly lifecycleClient: Pick<PlatformClient, "replayLifecycleEvents">;
  readonly signal: AbortSignal;
}): Promise<LifecycleProjection | null> {
  let projection = createLifecycleProjection(input.turnId);
  let afterSequence = null;
  do {
    const replay = await input.lifecycleClient.replayLifecycleEvents(
      { turnId: input.turnId, afterSequence, limit: 1_000 },
      { signal: input.signal },
    );
    if (input.signal.aborted) return null;
    for (const event of replay.events) {
      projection = applyConversationLifecycleEvent(projection, event);
    }
    afterSequence = replay.nextSequence;
  } while (afterSequence !== null);
  return projection;
}
