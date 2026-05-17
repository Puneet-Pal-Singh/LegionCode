import type {
  AppendMemoryEventInput,
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
    if (input.idempotencyKey) {
      const existing = this.events.find(
        (event) =>
          event.sessionId === input.sessionId &&
          event.idempotencyKey === input.idempotencyKey,
      );
      if (existing) return existing;
    }

    const record = {
      id: this.nextId(),
      userId: input.userId,
      sessionId: input.sessionId,
      runId: input.runId ?? null,
      eventType: input.eventType,
      payload: input.payload ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      createdAt: this.clock.now().toISOString(),
    } satisfies MemoryEventRecord;

    this.events.push(record);
    return record;
  }

  async listEventsBySession(
    sessionId: string,
    userId?: string,
  ): Promise<MemoryEventRecord[]> {
    return this.events.filter(
      (e) =>
        e.sessionId === sessionId &&
        (!userId || e.userId === userId),
    );
  }

  async transaction<T>(
    callback: (repository: MemoryEventRepository) => Promise<T>,
  ): Promise<T> {
    return await callback(this);
  }
}
