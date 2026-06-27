import { describe, it, expect, beforeEach } from "vitest";
import {
  MemoryRepository,
  type MemoryRepositoryDependencies,
  MemoryEventSchema,
  type MemoryEvent,
  type MemorySnapshot,
  type ReplayCheckpoint,
} from "./index.js";

// Import RuntimeDurableObjectState type
import type { RuntimeDurableObjectState } from "../types.js";

// Mock RuntimeDurableObjectState
class MockStorage {
  private data: Map<string, unknown> = new Map();

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string | string[]): Promise<void> {
    if (Array.isArray(key)) {
      key.forEach((k) => this.data.delete(k));
    } else {
      this.data.delete(key);
    }
  }

  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const result = new Map<string, T>();
    for (const [key, value] of this.data) {
      if (!options?.prefix || key.startsWith(options.prefix)) {
        result.set(key, value as T);
      }
    }
    return result;
  }

  async transaction<T>(closure: (txn: MockStorage) => Promise<T>): Promise<T> {
    return await closure(this);
  }

  async blockConcurrencyWhile<T>(closure: () => Promise<T>): Promise<T> {
    return await closure();
  }
}

class MockRuntimeDurableObjectState {
  storage = new MockStorage();

  async blockConcurrencyWhile<T>(closure: () => Promise<T>): Promise<T> {
    return await this.storage.blockConcurrencyWhile(closure);
  }
}

describe("MemoryRepository", () => {
  let repository: MemoryRepository;
  let ctx: MockRuntimeDurableObjectState;
  const testRunId = "run_550e8400e29b41d4a716446655440001";
  const testSessionId = crypto.randomUUID();

  beforeEach(() => {
    ctx = new MockRuntimeDurableObjectState();
    repository = new MemoryRepository({
      ctx: ctx as unknown as RuntimeDurableObjectState,
    });
  });

  const createEvent = (overrides: Partial<MemoryEvent> = {}): MemoryEvent =>
    MemoryEventSchema.parse({
      eventId: crypto.randomUUID(),
      idempotencyKey: `idem-key-${crypto.randomUUID()}`,
      runId: testRunId,
      sessionId: testSessionId,
      scope: "run",
      kind: "decision",
      content: "Test content",
      tags: ["test"],
      confidence: 0.9,
      source: "planner",
      createdAt: new Date().toISOString(),
      ...overrides,
    });

  describe("appendEvent", () => {
    it("should append a new event successfully", async () => {
      const event = createEvent();
      const result = await repository.appendEvent(event);

      expect(result).toBe(true);

      const events = await repository.getEvents(testRunId, "run");
      expect(events).toHaveLength(1);
      expect(events[0].content).toBe("Test content");
    });

    it("should reject duplicate events with same idempotency key", async () => {
      const idempotencyKey = "same-idempotency-key";
      const event = createEvent({ idempotencyKey });
      await repository.appendEvent(event);

      const duplicateEvent = createEvent({
        idempotencyKey,
        content: "Different content",
      });
      const result = await repository.appendEvent(duplicateEvent);

      expect(result).toBe(false);

      const events = await repository.getEvents(testRunId, "run");
      expect(events).toHaveLength(1);
      expect(events[0].content).toBe("Test content");
    });

    it("should accept events with different idempotency keys", async () => {
      const event1 = createEvent({ idempotencyKey: "idem-1" });
      const event2 = createEvent({
        idempotencyKey: "idem-2",
        content: "Second event",
      });

      await repository.appendEvent(event1);
      await repository.appendEvent(event2);

      const events = await repository.getEvents(testRunId, "run");
      expect(events).toHaveLength(2);
    });

    it("should handle different scopes independently", async () => {
      const runEvent = createEvent({
        scope: "run",
        idempotencyKey: `run-key-${crypto.randomUUID()}`,
      });
      const sessionEvent = createEvent({
        scope: "session",
        idempotencyKey: `session-key-${crypto.randomUUID()}`,
        sessionId: testSessionId,
      });

      await repository.appendEvent(runEvent);
      await repository.appendEvent(sessionEvent);

      const runEvents = await repository.getEvents(testRunId, "run");
      const sessionEvents = await repository.getEvents(
        testSessionId,
        "session",
      );

      expect(runEvents).toHaveLength(1);
      expect(sessionEvents).toHaveLength(1);
    });
  });

  describe("getEvents", () => {
    beforeEach(async () => {
      for (let i = 0; i < 10; i++) {
        await repository.appendEvent(
          createEvent({
            content: `Content ${i}`,
            createdAt: new Date(Date.now() - i * 1000).toISOString(),
          }),
        );
      }
    });

    it("should return all events by default", async () => {
      const events = await repository.getEvents(testRunId, "run");
      expect(events).toHaveLength(10);
    });

    it("should respect limit option", async () => {
      const events = await repository.getEvents(testRunId, "run", { limit: 5 });
      expect(events).toHaveLength(5);
    });

    it("should return events in order", async () => {
      const events = await repository.getEvents(testRunId, "run");
      expect(events.length).toBe(10);
    });
  });

  describe("updateSnapshot", () => {
    it("should create and retrieve snapshot", async () => {
      const snapshot: MemorySnapshot = {
        runId: testRunId,
        sessionId: testSessionId,
        summary: "Test summary",
        constraints: ["Constraint 1"],
        decisions: ["Decision 1"],
        todos: ["Todo 1"],
        updatedAt: new Date().toISOString(),
        version: 1,
      };

      await repository.updateSnapshot(snapshot);

      const retrieved = await repository.getSnapshot(testRunId, "run");
      expect(retrieved).toEqual(snapshot);
    });

    it("should update existing snapshot", async () => {
      const snapshot1: MemorySnapshot = {
        runId: testRunId,
        sessionId: testSessionId,
        summary: "First summary",
        constraints: [],
        decisions: [],
        todos: [],
        updatedAt: new Date().toISOString(),
        version: 1,
      };

      await repository.updateSnapshot(snapshot1);

      const snapshot2: MemorySnapshot = {
        ...snapshot1,
        summary: "Updated summary",
        version: 2,
      };

      await repository.updateSnapshot(snapshot2);

      const retrieved = await repository.getSnapshot(testRunId, "run");
      expect(retrieved?.summary).toBe("Updated summary");
      expect(retrieved?.version).toBe(2);
    });
  });

  describe("createCheckpoint and getCheckpoint", () => {
    it("should create and retrieve checkpoint", async () => {
      const checkpoint: ReplayCheckpoint = {
        checkpointId: crypto.randomUUID(),
        runId: testRunId,
        sequence: 1,
        phase: "planning",
        runStatus: "RUNNING",
        taskStatuses: { task1: "DONE" },
        memorySnapshotVersion: 1,
        memoryEventWatermark: 5,
        transcriptSequenceWatermark: 3,
        hash: "abc123",
        createdAt: new Date().toISOString(),
      };

      await repository.createCheckpoint(checkpoint);

      const retrieved = await repository.getCheckpoint(testRunId, 1);
      expect(retrieved).toEqual(checkpoint);
    });

    it("should return undefined for non-existent checkpoint", async () => {
      const retrieved = await repository.getCheckpoint(testRunId, 999);
      expect(retrieved).toBeUndefined();
    });
  });

  describe("getLatestCheckpoint", () => {
    it("should return the most recent checkpoint", async () => {
      for (let i = 1; i <= 3; i++) {
        await repository.createCheckpoint({
          checkpointId: crypto.randomUUID(),
          runId: testRunId,
          sequence: i,
          phase: "planning",
          runStatus: "RUNNING",
          taskStatuses: {},
          memorySnapshotVersion: 1,
          memoryEventWatermark: i * 5,
          transcriptSequenceWatermark: i * 3,
          hash: `hash-${i}`,
          createdAt: new Date().toISOString(),
        });
      }

      const latest = await repository.getLatestCheckpoint(testRunId);
      expect(latest?.sequence).toBe(3);
    });

    it("should return undefined when no checkpoints exist", async () => {
      const latest = await repository.getLatestCheckpoint(testRunId);
      expect(latest).toBeUndefined();
    });
  });

  describe("clearRunMemory", () => {
    it("should clear run-scoped memory", async () => {
      await repository.appendEvent(createEvent());
      await repository.updateSnapshot({
        runId: testRunId,
        sessionId: testSessionId,
        summary: "Test",
        constraints: [],
        decisions: [],
        todos: [],
        updatedAt: new Date().toISOString(),
        version: 1,
      });

      await repository.clearRunMemory(testRunId);

      const events = await repository.getEvents(testRunId, "run");
      expect(events).toHaveLength(0);

      const snapshot = await repository.getSnapshot(testRunId, "run");
      expect(snapshot).toBeUndefined();
    });
  });
});
