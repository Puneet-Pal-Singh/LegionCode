import {
  LifecycleEventSchema,
  type LifecycleEvent,
} from "@repo/platform-protocol/lifecycle";
import { EventStoreError } from "./errors.js";
import { createStableEventFingerprint } from "./fingerprint.js";
import type {
  LifecycleEventStore,
  ReplayLifecycleEventsInput,
  ReplayLifecycleEventsResult,
} from "./lifecycle-types.js";

const MAX_REPLAY_LIMIT = 1_000;

interface StoredLifecycleEvent {
  readonly event: LifecycleEvent;
  readonly fingerprint: string;
}

export class MemoryLifecycleEventStore implements LifecycleEventStore {
  private eventsByTurn = new Map<string, StoredLifecycleEvent[]>();
  private eventsById = new Map<string, StoredLifecycleEvent>();
  private eventsByIdempotencyKey = new Map<string, StoredLifecycleEvent>();

  async append(event: LifecycleEvent): Promise<LifecycleEvent> {
    return (await this.appendBatch([event]))[0] as LifecycleEvent;
  }

  async appendBatch(
    events: readonly LifecycleEvent[],
  ): Promise<readonly LifecycleEvent[]> {
    const parsed = events.map((event) => LifecycleEventSchema.parse(event));
    const draft = this.clone();
    const appended = parsed.map((event) => draft.appendOne(event));
    this.eventsByTurn = draft.eventsByTurn;
    this.eventsById = draft.eventsById;
    this.eventsByIdempotencyKey = draft.eventsByIdempotencyKey;
    return structuredClone(appended);
  }

  async replay(
    input: ReplayLifecycleEventsInput,
  ): Promise<ReplayLifecycleEventsResult> {
    validateReplay(input);
    const events = this.eventsByTurn.get(input.turnId) ?? [];
    const after = input.afterSequence ?? 0;
    const replay = events
      .filter(({ event }) => event.sequence > after)
      .slice(0, input.limit)
      .map(({ event }) => event);
    assertReplayContinuity(replay, after);
    return {
      events: structuredClone(replay),
      nextSequence: replay.at(-1)?.sequence ?? null,
    };
  }

  private appendOne(event: LifecycleEvent): LifecycleEvent {
    const key = `${event.turnId}:${event.idempotencyKey}`;
    const fingerprint = createStableEventFingerprint(event);
    const existing = this.eventsByIdempotencyKey.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new EventStoreError(
          "idempotency_conflict",
          `Lifecycle idempotency key conflicts: ${event.idempotencyKey}`,
        );
      }
      return existing.event;
    }
    this.assertAppendable(event);
    const stored = { event: structuredClone(event), fingerprint };
    const events = this.eventsByTurn.get(event.turnId) ?? [];
    this.eventsByTurn.set(event.turnId, [...events, stored]);
    this.eventsById.set(event.eventId, stored);
    this.eventsByIdempotencyKey.set(key, stored);
    return event;
  }

  private assertAppendable(event: LifecycleEvent): void {
    if (this.eventsById.has(event.eventId)) {
      throw new EventStoreError(
        "event_id_conflict",
        `Event ID exists: ${event.eventId}`,
      );
    }
    const events = this.eventsByTurn.get(event.turnId) ?? [];
    const previous = events.at(-1)?.event.sequence ?? 0;
    if (event.sequence <= previous) {
      throw new EventStoreError(
        "sequence_gap",
        `Lifecycle sequence must increase after ${previous}, received ${event.sequence}`,
      );
    }
  }

  private clone(): MemoryLifecycleEventStore {
    const clone = new MemoryLifecycleEventStore();
    clone.eventsByTurn = new Map(this.eventsByTurn);
    clone.eventsById = new Map(this.eventsById);
    clone.eventsByIdempotencyKey = new Map(this.eventsByIdempotencyKey);
    return clone;
  }
}

function validateReplay(input: ReplayLifecycleEventsInput): void {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > MAX_REPLAY_LIMIT
  ) {
    throw new EventStoreError(
      "invalid_replay_limit",
      "Invalid lifecycle replay limit",
    );
  }
  if (
    input.afterSequence !== null &&
    (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0)
  ) {
    throw new EventStoreError(
      "cursor_not_found",
      "Invalid lifecycle replay sequence",
    );
  }
}

function assertReplayContinuity(
  events: readonly LifecycleEvent[],
  afterSequence: number,
): void {
  for (const [index, event] of events.entries()) {
    const expected = afterSequence + index + 1;
    if (event.sequence !== expected) {
      throw new EventStoreError(
        "corrupt_event_stream",
        `Lifecycle replay expected sequence ${expected}, received ${event.sequence}`,
      );
    }
  }
}
