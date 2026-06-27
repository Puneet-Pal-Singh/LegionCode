export const EVENT_STORE_ERROR_CODES = [
  "cursor_conflict",
  "cursor_not_found",
  "event_id_conflict",
  "idempotency_conflict",
  "invalid_replay_limit",
  "sequence_gap",
  "corrupt_event_stream",
] as const;

export type EventStoreErrorCode = (typeof EVENT_STORE_ERROR_CODES)[number];

export class EventStoreError extends Error {
  readonly name = "EventStoreError";

  constructor(
    readonly code: EventStoreErrorCode,
    message: string,
  ) {
    super(message);
  }
}
