import type {
  EventCursor,
  EventId,
  EventScope,
  PlatformEvent,
  ProtocolTimestamp,
} from "@repo/platform-protocol";

type StoreOwnedEventField =
  | "eventId"
  | "sequence"
  | "cursor"
  | "createdAt";

type WithoutStoreOwnedFields<T> = T extends PlatformEvent
  ? Omit<T, StoreOwnedEventField>
  : never;

export type AppendEventInput = WithoutStoreOwnedFields<PlatformEvent>;

export interface ReplayEventsInput {
  scope: EventScope;
  afterCursor: EventCursor | null;
  limit: number;
}

export interface ReplayEventsResult {
  events: readonly PlatformEvent[];
  nextCursor: EventCursor | null;
}

export interface EventStore {
  append(input: AppendEventInput): Promise<PlatformEvent>;
  appendBatch(inputs: readonly AppendEventInput[]): Promise<readonly PlatformEvent[]>;
  replay(input: ReplayEventsInput): Promise<ReplayEventsResult>;
}

export interface EventStoreClock {
  now(): ProtocolTimestamp;
}

export interface EventStoreIdGenerator {
  nextEventId(): EventId;
  nextCursor(): EventCursor;
}
