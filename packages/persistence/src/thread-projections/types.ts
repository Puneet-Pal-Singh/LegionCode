import type {
  EventCursor,
  PlatformEvent,
  Thread,
  ThreadId,
  ThreadItem,
  TurnId,
  UserId,
} from "@repo/platform-protocol";

export const THREAD_PROJECTION_VERSION = 1;

export interface ThreadReadReceipt {
  threadId: ThreadId;
  viewerId: UserId;
  lastAcknowledgedTerminalTurnId: TurnId | null;
  acknowledgedAt: string;
}

export interface AcknowledgeThreadInput {
  threadId: ThreadId;
  viewerId: UserId;
  terminalTurnId: TurnId;
  acknowledgedAt: string;
}

export interface ApplyGeneratedTitleInput {
  threadId: ThreadId;
  title: string;
  expectedTitleVersion: number;
  terminalTurnId: TurnId;
}

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
  getThreadReadReceipt(
    threadId: ThreadId,
    viewerId: UserId,
  ): Promise<ThreadReadReceipt | null>;
  acknowledgeThread(input: AcknowledgeThreadInput): Promise<ThreadReadReceipt>;
  applyGeneratedTitle(input: ApplyGeneratedTitleInput): Promise<boolean>;
}

export class ThreadProjectionError extends Error {
  constructor(
    readonly code:
      | "event_thread_mismatch"
      | "missing_thread_created"
      | "missing_item_source"
      | "invalid_projection_sequence"
      | "acknowledgement_turn_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "ThreadProjectionError";
  }
}
