import type { EventId, TurnId } from "@repo/platform-protocol";

export const EVENT_STORE_ERROR_CODES = [
  "cursor_conflict",
  "cursor_not_found",
  "event_id_conflict",
  "idempotency_conflict",
  "invalid_replay_limit",
  "invalid_replay_byte_budget",
  "lifecycle_event_too_large",
  "history_row_too_large",
  "sequence_gap",
  "corrupt_event_stream",
  "terminal_stream",
] as const;

export type EventStoreErrorCode = (typeof EVENT_STORE_ERROR_CODES)[number];

export class EventStoreError extends Error {
  readonly name: string = "EventStoreError";

  constructor(
    readonly code: EventStoreErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Descriptor only: the excluded canonical event remains in the existing store. */
export class LifecycleReplayEventTooLargeError extends EventStoreError {
  override readonly name = "LifecycleReplayEventTooLargeError";

  constructor(
    readonly turnId: TurnId,
    readonly eventId: EventId,
    readonly sequence: number,
    readonly encodedByteLength: number,
  ) {
    super("lifecycle_event_too_large", "The next lifecycle event exceeds the replay byte budget");
  }
}

export class LocalPersistenceError extends Error {
  readonly name = "LocalPersistenceError";

  constructor(readonly code: "unavailable" | "corrupt", message: string) {
    super(message);
  }
}
