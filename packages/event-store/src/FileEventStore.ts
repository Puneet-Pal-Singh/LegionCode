import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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
import { createStableEventFingerprint } from "./fingerprint.js";
import type {
  AppendEventInput,
  EventStore,
  EventStoreClock,
  EventStoreIdGenerator,
  ReplayEventsInput,
  ReplayEventsResult,
} from "./types.js";

const MAX_REPLAY_LIMIT = 1_000;
const STORAGE_VERSION = 1;

type FileEventStoreOptions = {
  clock?: EventStoreClock;
  idGenerator?: EventStoreIdGenerator;
};

type StoredFile = {
  version: typeof STORAGE_VERSION;
  events: readonly PlatformEvent[];
};

interface StoredEvent {
  event: PlatformEvent;
  fingerprint: string;
}

interface State {
  events: StoredEvent[];
  byCursor: Map<EventCursor, StoredEvent>;
  byEventId: Map<EventId, StoredEvent>;
  byIdempotencyKey: Map<string, StoredEvent>;
  sequenceByScope: Map<string, number>;
}

const systemClock: EventStoreClock = {
  now: () => new Date().toISOString(),
};

const systemIdGenerator: EventStoreIdGenerator = {
  nextEventId: () => `evt_${randomUUID()}` as EventId,
  nextCursor: () => `cursor_${randomUUID()}` as EventCursor,
};

/**
 * Durable append/replay storage for the local App Server.
 *
 * Each mutation is serialized in-process and committed with temp-file rename,
 * so a renderer restart cannot turn the event log into an in-memory cache.
 */
export class FileEventStore implements EventStore {
  private state: State | null = null;
  private pending: Promise<unknown> = Promise.resolve();
  private readonly clock: EventStoreClock;
  private readonly idGenerator: EventStoreIdGenerator;

  constructor(private readonly filePath: string, options: FileEventStoreOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.idGenerator = options.idGenerator ?? systemIdGenerator;
  }

  async append(input: AppendEventInput): Promise<PlatformEvent> {
    return await this.runExclusive(async () => {
      const state = await this.loadState();
      const draft = cloneState(state);
      const event = appendToState(draft, input, this.clock, this.idGenerator);
      await this.persist(draft);
      this.state = draft;
      return structuredClone(event);
    });
  }

  async appendBatch(inputs: readonly AppendEventInput[]): Promise<readonly PlatformEvent[]> {
    return await this.runExclusive(async () => {
      const state = await this.loadState();
      const draft = cloneState(state);
      const events = inputs.map((input) =>
        appendToState(draft, input, this.clock, this.idGenerator),
      );
      await this.persist(draft);
      this.state = draft;
      return structuredClone(events);
    });
  }

  async replay(input: ReplayEventsInput): Promise<ReplayEventsResult> {
    const state = await this.loadState();
    const scope = EventScopeSchema.parse(input.scope);
    const afterCursor = input.afterCursor === null
      ? null
      : EventCursorSchema.parse(input.afterCursor);
    validateReplayLimit(input.limit);
    const scopedEvents = state.events.filter(({ event }) => sameScope(event, scope));
    const startIndex = findReplayStart(scopedEvents, afterCursor);
    const events = scopedEvents
      .slice(startIndex, startIndex + input.limit)
      .map(({ event }) => structuredClone(event));
    return { events, nextCursor: events.at(-1)?.cursor ?? null };
  }

  async listAll(): Promise<readonly PlatformEvent[]> {
    const state = await this.loadState();
    return state.events.map(({ event }) => structuredClone(event));
  }

  private async loadState(): Promise<State> {
    if (this.state) return this.state;
    let stored: StoredFile;
    try {
      stored = JSON.parse(await readFile(this.filePath, "utf8")) as StoredFile;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        this.state = createState([]);
        return this.state;
      }
      throw new EventStoreError("corrupt_event_stream", "Local event store is corrupt");
    }
    if (stored.version !== STORAGE_VERSION || !Array.isArray(stored.events)) {
      throw new EventStoreError("corrupt_event_stream", "Local event store is corrupt");
    }
    try {
      this.state = createState(stored.events.map((event) => PlatformEventSchema.parse(event)));
    } catch {
      throw new EventStoreError("corrupt_event_stream", "Local event store is corrupt");
    }
    return this.state;
  }

  private async persist(state: State): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporaryPath,
        JSON.stringify({ version: STORAGE_VERSION, events: state.events.map(({ event }) => event) }),
        { encoding: "utf8", mode: 0o600 },
      );
      await rename(temporaryPath, this.filePath);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation, operation);
    this.pending = next.then(() => undefined, () => undefined);
    return await next;
  }
}

function appendToState(
  state: State,
  input: AppendEventInput,
  clock: EventStoreClock,
  idGenerator: EventStoreIdGenerator,
): PlatformEvent {
  const scopeKey = buildScopeKey(input);
  const fingerprint = createStableEventFingerprint(input);
  const existing = state.byIdempotencyKey.get(`${scopeKey}:${input.idempotencyKey}`);
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      throw new EventStoreError("idempotency_conflict", "Idempotency key was already used for a different event");
    }
    return existing.event;
  }
  const event = PlatformEventSchema.parse({
    ...input,
    eventId: idGenerator.nextEventId(),
    cursor: idGenerator.nextCursor(),
    sequence: (state.sequenceByScope.get(scopeKey) ?? 0) + 1,
    createdAt: clock.now(),
  });
  if (state.byEventId.has(event.eventId) || state.byCursor.has(event.cursor)) {
    throw new EventStoreError("event_id_conflict", "Generated event identity already exists");
  }
  const stored = { event: structuredClone(event), fingerprint };
  state.events.push(stored);
  state.byEventId.set(event.eventId, stored);
  state.byCursor.set(event.cursor, stored);
  state.byIdempotencyKey.set(`${scopeKey}:${event.idempotencyKey}`, stored);
  state.sequenceByScope.set(scopeKey, event.sequence);
  return event;
}

function createState(events: readonly PlatformEvent[]): State {
  const state: State = {
    events: [],
    byCursor: new Map(),
    byEventId: new Map(),
    byIdempotencyKey: new Map(),
    sequenceByScope: new Map(),
  };
  for (const event of events) {
    const scopeKey = buildScopeKey(event);
    const expectedSequence = (state.sequenceByScope.get(scopeKey) ?? 0) + 1;
    if (event.sequence !== expectedSequence) {
      throw new EventStoreError("corrupt_event_stream", "Local event store contains a sequence gap");
    }
    const stored = { event: structuredClone(event), fingerprint: createStableEventFingerprint(event) };
    if (state.byEventId.has(event.eventId) || state.byCursor.has(event.cursor) || state.byIdempotencyKey.has(`${scopeKey}:${event.idempotencyKey}`)) {
      throw new EventStoreError("corrupt_event_stream", "Local event store contains duplicate identities");
    }
    state.events.push(stored);
    state.byEventId.set(event.eventId, stored);
    state.byCursor.set(event.cursor, stored);
    state.byIdempotencyKey.set(`${scopeKey}:${event.idempotencyKey}`, stored);
    state.sequenceByScope.set(scopeKey, event.sequence);
  }
  return state;
}

function cloneState(state: State): State {
  const cloned: State = {
    events: [],
    byCursor: new Map(),
    byEventId: new Map(),
    byIdempotencyKey: new Map(),
    sequenceByScope: new Map(state.sequenceByScope),
  };
  for (const stored of state.events) {
    const copy = { event: structuredClone(stored.event), fingerprint: stored.fingerprint };
    cloned.events.push(copy);
    cloned.byCursor.set(copy.event.cursor, copy);
    cloned.byEventId.set(copy.event.eventId, copy);
    cloned.byIdempotencyKey.set(
      `${buildScopeKey(copy.event)}:${copy.event.idempotencyKey}`,
      copy,
    );
  }
  return cloned;
}

function sameScope(event: PlatformEvent, scope: EventScope): boolean {
  return event.scopeType === scope.scopeType && event.scopeId === scope.scopeId;
}

function buildScopeKey(scope: { scopeType: string; scopeId: string }): string {
  return `${scope.scopeType}:${scope.scopeId}`;
}

function findReplayStart(events: readonly StoredEvent[], afterCursor: EventCursor | null): number {
  if (afterCursor === null) return 0;
  const index = events.findIndex(({ event }) => event.cursor === afterCursor);
  if (index < 0) throw new EventStoreError("cursor_not_found", "Replay cursor does not exist in the requested scope");
  return index + 1;
}

function validateReplayLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_REPLAY_LIMIT) {
    throw new EventStoreError("invalid_replay_limit", `Replay limit must be between 1 and ${MAX_REPLAY_LIMIT}`);
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
