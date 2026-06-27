import {
  ThreadItemSchema,
  ThreadSchema,
  type PlatformEvent,
  type Thread,
  type ThreadId,
  type ThreadItem,
} from "@repo/platform-protocol";
import {
  THREAD_PROJECTION_VERSION,
  ThreadProjectionError,
  type ThreadProjectionEventInput,
  type ThreadProjectionSnapshot,
} from "./types.js";

interface ProjectionState {
  thread: Thread | null;
  itemsById: Map<string, ThreadItem>;
  lastCursor: ThreadProjectionSnapshot["lastCursor"] | null;
  lastProjectionSequence: number;
}

export function projectThreadEvents(
  threadId: ThreadId,
  inputs: readonly ThreadProjectionEventInput[],
): ThreadProjectionSnapshot | null {
  const state: ProjectionState = {
    thread: null,
    itemsById: new Map(),
    lastCursor: null,
    lastProjectionSequence: 0,
  };

  for (const input of inputs) {
    applyProjectionInput(state, threadId, input);
  }

  if (!state.thread) {
    return null;
  }

  return {
    thread: state.thread,
    items: [...state.itemsById.values()].sort(sortItems),
    lastCursor: requireLastCursor(state),
    projectionVersion: THREAD_PROJECTION_VERSION,
  };
}

function applyProjectionInput(
  state: ProjectionState,
  threadId: ThreadId,
  input: ThreadProjectionEventInput,
): void {
  validateProjectionInput(threadId, input, state.lastProjectionSequence + 1);
  state.lastCursor = input.event.cursor;
  state.lastProjectionSequence = input.projectionSequence;

  if (isThreadStateEvent(input.event)) {
    state.thread = projectThreadState(input.event, input.projectionSequence);
    return;
  }

  if (isThreadItemEvent(input.event)) {
    const item = projectThreadItem(input.event, input.projectionSequence);
    state.itemsById.set(item.id, item);
    state.thread = updateActiveLeafItem(state.thread, item);
  }
}

function validateProjectionInput(
  threadId: ThreadId,
  input: ThreadProjectionEventInput,
  expectedSequence: number,
): void {
  if (
    !Number.isSafeInteger(input.projectionSequence) ||
    input.projectionSequence < 1
  ) {
    throw new ThreadProjectionError(
      "invalid_projection_sequence",
      "Projection sequence must be a positive safe integer",
    );
  }
  if (input.projectionSequence !== expectedSequence) {
    throw new ThreadProjectionError(
      "invalid_projection_sequence",
      `Projection sequence must be ${expectedSequence}, received ${input.projectionSequence}`,
    );
  }
  if (input.event.threadId !== threadId) {
    throw new ThreadProjectionError(
      "event_thread_mismatch",
      "Projection event does not belong to the requested thread",
    );
  }
}

function isThreadStateEvent(
  event: PlatformEvent,
): event is Extract<PlatformEvent, { type: `thread.${string}` }> {
  return event.type.startsWith("thread.");
}

function isThreadItemEvent(
  event: PlatformEvent,
): event is Extract<PlatformEvent, { type: `item.${string}` }> {
  return event.type.startsWith("item.");
}

function projectThreadState(
  event: Extract<PlatformEvent, { type: `thread.${string}` }>,
  projectionSequence: number,
): Thread {
  return ThreadSchema.parse({
    ...event.payload.thread,
    lastEventSequence: projectionSequence,
  });
}

function projectThreadItem(
  event: Extract<PlatformEvent, { type: `item.${string}` }>,
  projectionSequence: number,
): ThreadItem {
  return ThreadItemSchema.parse({
    ...event.payload.item,
    eventSequence: projectionSequence,
  });
}

function updateActiveLeafItem(
  thread: Thread | null,
  item: ThreadItem,
): Thread | null {
  if (!thread) {
    return null;
  }
  return ThreadSchema.parse({
    ...thread,
    activeRunId: item.runId ?? thread.activeRunId,
    activeLeafItemId: item.id,
    updatedAt: item.completedAt ?? item.createdAt,
    lastEventSequence: item.eventSequence,
  });
}

function requireLastCursor(
  state: ProjectionState,
): ThreadProjectionSnapshot["lastCursor"] {
  if (state.lastCursor === null) {
    throw new ThreadProjectionError(
      "missing_thread_created",
      "Thread projection has no cursor",
    );
  }
  return state.lastCursor;
}

function sortItems(left: ThreadItem, right: ThreadItem): number {
  return left.eventSequence - right.eventSequence;
}
