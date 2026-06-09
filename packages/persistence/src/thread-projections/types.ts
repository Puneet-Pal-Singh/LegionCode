import type {
  EventCursor,
  PlatformEvent,
  Thread,
  ThreadId,
  ThreadItem,
} from "@repo/platform-protocol";

export const THREAD_PROJECTION_VERSION = 1;

export interface ThreadProjectionEventInput {
  event: PlatformEvent;
  projectionSequence: number;
}

export interface ThreadProjectionSnapshot {
  thread: Thread;
  items: readonly ThreadItem[];
  lastCursor: EventCursor;
  projectionVersion: typeof THREAD_PROJECTION_VERSION;
}

export interface RebuildThreadProjectionInput {
  threadId: ThreadId;
  events: readonly ThreadProjectionEventInput[];
}

export interface ThreadProjectionRepository {
  rebuildFromEvents(
    input: RebuildThreadProjectionInput,
  ): Promise<ThreadProjectionSnapshot | null>;
  getThreadProjection(
    threadId: ThreadId,
  ): Promise<ThreadProjectionSnapshot | null>;
}

export class ThreadProjectionError extends Error {
  constructor(
    readonly code:
      | "event_thread_mismatch"
      | "missing_thread_created"
      | "missing_item_source"
      | "invalid_projection_sequence",
    message: string,
  ) {
    super(message);
    this.name = "ThreadProjectionError";
  }
}
