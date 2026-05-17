import type {
  AppendMemoryEventInput,
  AppendMemoryEventResult,
  MemoryEventRecord,
  MemoryEventRepository,
} from "./types.js";

interface Clock {
  now(): Date;
}

const systemClock: Clock = {
  now: () => new Date(),
};

export class InMemoryEventRepository implements MemoryEventRepository {
  private readonly events: MemoryEventRecord[] = [];
  private idCounter = 0;

  constructor(private readonly clock: Clock = systemClock) {}

  private nextId(): string {
    this.idCounter += 1;
    return `me-${this.idCounter}`;
  }

  async appendEvent(input: AppendMemoryEventInput): Promise<MemoryEventRecord> {
    const result = await this.appendEventIfAbsent(input);
    return result.record;
  }

  async appendEventIfAbsent(
    input: AppendMemoryEventInput,
  ): Promise<AppendMemoryEventResult> {
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);

    if (idempotencyKey !== null) {
      const existing = this.events.find(
        (event) =>
          event.sessionId === input.sessionId &&
          event.idempotencyKey === idempotencyKey,
      );
      if (existing) {
        return { record: cloneEvent(existing), inserted: false };
      }
    }

    const record = {
      id: this.nextId(),
      userId: input.userId,
      sessionId: input.sessionId,
      runId: input.runId ?? null,
      eventType: input.eventType,
      payload: input.payload ?? null,
      idempotencyKey,
      createdAt: this.clock.now().toISOString(),
    } satisfies MemoryEventRecord;

    this.events.push(record);
    return { record: cloneEvent(record), inserted: true };
  }

  async listEventsBySession(
    sessionId: string,
    userId?: string,
  ): Promise<MemoryEventRecord[]> {
    return this.events
      .filter(
        (e) =>
          e.sessionId === sessionId &&
          (!userId || e.userId === userId),
      )
      .map(cloneEvent);
  }

  async transaction<T>(
    callback: (repository: MemoryEventRepository) => Promise<T>,
  ): Promise<T> {
    const eventsBefore = this.events.map(cloneEvent);
    const idCounterBefore = this.idCounter;

    try {
      return await callback(this);
    } catch (error) {
      this.events.length = 0;
      this.events.push(...eventsBefore);
      this.idCounter = idCounterBefore;
      throw error;
    }
  }
}

function normalizeIdempotencyKey(value: string | null | undefined): string | null {
  return value ?? null;
}

function cloneEvent(record: MemoryEventRecord): MemoryEventRecord {
  return {
    ...record,
    payload: cloneJson(record.payload),
  };
}

function cloneJson<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}
