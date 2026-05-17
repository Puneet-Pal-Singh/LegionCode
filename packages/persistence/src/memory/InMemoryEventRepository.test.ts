import { describe, expect, it } from "vitest";
import { InMemoryEventRepository } from "./InMemoryEventRepository.js";

describe("InMemoryEventRepository", () => {
  const mockClock = { now: () => new Date("2025-01-01T00:00:00Z") };

  it("should append and list events by session", async () => {
    const repo = new InMemoryEventRepository(mockClock);

    const event = await repo.appendEvent({
      userId: "user-1",
      sessionId: "session-1",
      eventType: "memory_update",
    });

    expect(event.id).toBeTruthy();
    expect(event.eventType).toBe("memory_update");

    const events = await repo.listEventsBySession("session-1");
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe(event.id);
  });

  it("should filter events by userId", async () => {
    const repo = new InMemoryEventRepository(mockClock);

    const filtered = await repo.listEventsBySession("session-1", "user-2");
    expect(filtered).toHaveLength(0);
  });

  it("should support transaction", async () => {
    const repo = new InMemoryEventRepository(mockClock);

    const result = await repo.transaction(async (txRepo) => {
      return await txRepo.appendEvent({
        userId: "user-1",
        sessionId: "session-1",
        eventType: "memory_update",
      });
    });

    expect(result.id).toBeTruthy();
  });

  it("should return the existing event for duplicate idempotency keys in a session", async () => {
    const repo = new InMemoryEventRepository(mockClock);

    const first = await repo.appendEvent({
      userId: "user-1",
      sessionId: "session-1",
      eventType: "memory_update",
      idempotencyKey: "idem-1",
    });
    const duplicate = await repo.appendEvent({
      userId: "user-1",
      sessionId: "session-1",
      eventType: "memory_update",
      idempotencyKey: "idem-1",
    });

    expect(duplicate.id).toBe(first.id);
    await repo.appendEvent({
      userId: "user-1",
      sessionId: "session-2",
      eventType: "memory_update",
      idempotencyKey: "idem-1",
    });
    expect(await repo.listEventsBySession("session-1")).toHaveLength(1);
    expect(await repo.listEventsBySession("session-2")).toHaveLength(1);
  });
});
