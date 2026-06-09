import {
  EventCursorSchema,
  EventScopeSchema,
  PlatformEventSchema,
  type EventCursor,
  type EventId,
  type EventScope,
  type PlatformEvent,
} from "@repo/platform-protocol";
import { EventStoreError } from "./errors.js";
import type {
  AppendEventInput,
  EventStore,
  EventStoreClock,
  EventStoreIdGenerator,
  ReplayEventsInput,
  ReplayEventsResult,
} from "./types.js";

const MAX_REPLAY_LIMIT = 1_000;

const systemClock: EventStoreClock = {
  now: () => new Date().toISOString(),
};

const systemIdGenerator: EventStoreIdGenerator = {
  nextEventId: () => `evt_${crypto.randomUUID()}` as EventId,
  nextCursor: () => `cursor_${crypto.randomUUID()}` as EventCursor,
};

interface StoredEvent {
  event: PlatformEvent;
  fingerprint: string;
}

interface MemoryState {
  events: StoredEvent[];
  byCursor: Map<EventCursor, StoredEvent>;
  byEventId: Map<EventId, StoredEvent>;
  byIdempotencyKey: Map<string, StoredEvent>;
  sequenceByScope: Map<string, number>;
}

export class MemoryEventStore implements EventStore {
  private state = createEmptyState();

  constructor(
    private readonly clock: EventStoreClock = systemClock,
    private readonly idGenerator: EventStoreIdGenerator = systemIdGenerator,
  ) {}

  async append(input: AppendEventInput): Promise<PlatformEvent> {
    return cloneEvent(this.appendToState(this.state, input));
  }

  async appendBatch(
    inputs: readonly AppendEventInput[],
  ): Promise<readonly PlatformEvent[]> {
    const draft = cloneState(this.state);
    const events = inputs.map((input) => this.appendToState(draft, input));
    this.state = draft;
    return events.map(cloneEvent);
  }

  async replay(input: ReplayEventsInput): Promise<ReplayEventsResult> {
    const scope = EventScopeSchema.parse(input.scope);
    const afterCursor = parseReplayCursor(input.afterCursor);
    validateReplayLimit(input.limit);
    const scopedEvents = this.listScopeEvents(scope);
    const startIndex = findReplayStart(scopedEvents, afterCursor);
    const events = scopedEvents
      .slice(startIndex, startIndex + input.limit)
      .map(({ event }) => cloneEvent(event));
    return {
      events,
      nextCursor: events.at(-1)?.cursor ?? null,
    };
  }

  private appendToState(
    state: MemoryState,
    input: AppendEventInput,
  ): PlatformEvent {
    const scopeKey = buildScopeKey(input);
    const fingerprint = stableStringify(input);
    const existing = state.byIdempotencyKey.get(
      buildIdempotencyKey(scopeKey, input.idempotencyKey),
    );
    if (existing) {
      return resolveIdempotentRetry(existing, fingerprint);
    }

    const event = this.createEvent(state, input, scopeKey);
    assertUniqueStoreIds(state, event);
    storeEvent(state, event, fingerprint, scopeKey);
    return event;
  }

  private createEvent(
    state: MemoryState,
    input: AppendEventInput,
    scopeKey: string,
  ): PlatformEvent {
    const sequence = (state.sequenceByScope.get(scopeKey) ?? 0) + 1;
    return PlatformEventSchema.parse({
      ...input,
      eventId: this.idGenerator.nextEventId(),
      cursor: this.idGenerator.nextCursor(),
      sequence,
      createdAt: this.clock.now(),
    });
  }

  private listScopeEvents(scope: EventScope): StoredEvent[] {
    const scopeKey = buildScopeKey(scope);
    return this.state.events.filter(
      ({ event }) => buildScopeKey(event) === scopeKey,
    );
  }
}

function createEmptyState(): MemoryState {
  return {
    events: [],
    byCursor: new Map(),
    byEventId: new Map(),
    byIdempotencyKey: new Map(),
    sequenceByScope: new Map(),
  };
}

function cloneState(state: MemoryState): MemoryState {
  return {
    events: [...state.events],
    byCursor: new Map(state.byCursor),
    byEventId: new Map(state.byEventId),
    byIdempotencyKey: new Map(state.byIdempotencyKey),
    sequenceByScope: new Map(state.sequenceByScope),
  };
}

function resolveIdempotentRetry(
  existing: StoredEvent,
  fingerprint: string,
): PlatformEvent {
  if (existing.fingerprint !== fingerprint) {
    throw new EventStoreError(
      "idempotency_conflict",
      "Idempotency key was already used for a different event",
    );
  }
  return existing.event;
}

function assertUniqueStoreIds(state: MemoryState, event: PlatformEvent): void {
  if (state.byEventId.has(event.eventId)) {
    throw new EventStoreError(
      "event_id_conflict",
      `Event ID already exists: ${event.eventId}`,
    );
  }
  if (state.byCursor.has(event.cursor)) {
    throw new EventStoreError(
      "cursor_conflict",
      `Event cursor already exists: ${event.cursor}`,
    );
  }
}

function storeEvent(
  state: MemoryState,
  event: PlatformEvent,
  fingerprint: string,
  scopeKey: string,
): void {
  const stored = { event: cloneEvent(event), fingerprint };
  state.events.push(stored);
  state.byEventId.set(event.eventId, stored);
  state.byCursor.set(event.cursor, stored);
  state.byIdempotencyKey.set(
    buildIdempotencyKey(scopeKey, event.idempotencyKey),
    stored,
  );
  state.sequenceByScope.set(scopeKey, event.sequence);
}

function findReplayStart(
  events: readonly StoredEvent[],
  afterCursor: EventCursor | null,
): number {
  if (afterCursor === null) {
    return 0;
  }
  const cursorIndex = events.findIndex(
    ({ event }) => event.cursor === afterCursor,
  );
  if (cursorIndex < 0) {
    throw new EventStoreError(
      "cursor_not_found",
      "Replay cursor does not exist in the requested scope",
    );
  }
  return cursorIndex + 1;
}

function parseReplayCursor(afterCursor: EventCursor | null): EventCursor | null {
  if (afterCursor === null) {
    return null;
  }
  return EventCursorSchema.parse(afterCursor);
}

function validateReplayLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_REPLAY_LIMIT) {
    throw new EventStoreError(
      "invalid_replay_limit",
      `Replay limit must be between 1 and ${MAX_REPLAY_LIMIT}`,
    );
  }
}

function buildScopeKey(scope: EventScope): string {
  return `${scope.scopeType}:${scope.scopeId}`;
}

function buildIdempotencyKey(scopeKey: string, idempotencyKey: string): string {
  return `${scopeKey}:${idempotencyKey}`;
}

function cloneEvent(event: PlatformEvent): PlatformEvent {
  return structuredClone(event);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJsonValue(entry)]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
