import { beforeEach, describe, expect, it } from "vitest";
import {
  MemoryCoordinator,
  MemoryEventSchema,
  MemoryRepository,
  type MemoryEvent,
  type MemorySnapshot,
} from "./index.js";
import type { RuntimeDurableObjectState } from "../types.js";

class MockStorage {
  private data: Map<string, unknown> = new Map();

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string | string[]): Promise<boolean> {
    if (Array.isArray(key)) {
      key.forEach((k) => {
        this.data.delete(k);
      });
      return true;
    }

    return this.data.delete(key);
  }

  async list<T>(options?: {
    prefix?: string;
    start?: string;
    end?: string;
    limit?: number;
  }): Promise<Map<string, T>> {
    const result = new Map<string, T>();
    for (const [key, value] of this.data.entries()) {
      if (options?.prefix && !key.startsWith(options.prefix)) {
        continue;
      }
      result.set(key, value as T);
      if (options?.limit && result.size >= options.limit) {
        break;
      }
    }
    return result;
  }
}

class MockRuntimeDurableObjectState implements RuntimeDurableObjectState {
  storage = new MockStorage();

  async blockConcurrencyWhile<T>(closure: () => Promise<T>): Promise<T> {
    return closure();
  }
}

class InMemorySessionMemoryClient {
  public appendCount = 0;
  private eventsBySession = new Map<string, MemoryEvent[]>();
  private snapshotsBySession = new Map<string, MemorySnapshot>();

  async appendSessionMemory(event: unknown): Promise<boolean> {
    const parsed = MemoryEventSchema.parse(event);
    if (parsed.scope !== "session") {
      return false;
    }

    const existing = this.eventsBySession.get(parsed.sessionId) ?? [];
    if (
      existing.some((item) => item.idempotencyKey === parsed.idempotencyKey)
    ) {
      return false;
    }

    existing.push(parsed);
    this.eventsBySession.set(parsed.sessionId, existing);
    this.appendCount += 1;
    return true;
  }

  async getSessionMemoryContext(
    sessionId: string,
    _prompt: string,
    limit?: number,
  ): Promise<{ events: unknown[]; snapshot?: unknown }> {
    const events = this.eventsBySession.get(sessionId) ?? [];
    return {
      events: typeof limit === "number" ? events.slice(0, limit) : events,
      snapshot: this.snapshotsBySession.get(sessionId),
    };
  }

  async getSessionSnapshot(sessionId: string): Promise<unknown | undefined> {
    return this.snapshotsBySession.get(sessionId);
  }

  async upsertSessionSnapshot(snapshot: unknown): Promise<void> {
    const parsed = snapshot as MemorySnapshot;
    this.snapshotsBySession.set(parsed.sessionId, parsed);
  }
}

describe("MemoryCoordinator session memory wiring", () => {
  let sessionMemoryClient: InMemorySessionMemoryClient;

  beforeEach(() => {
    sessionMemoryClient = new InMemorySessionMemoryClient();
  });

  it("writes session-scoped memory to the session-memory client and retrieves it across runs", async () => {
    const sessionId = "session-shared-memory";
    const runIdOne = "run_550e8400e29b41d4a716446655440001";
    const runIdTwo = "run_550e8400e29b41d4a716446655440002";

    const coordinatorOne = new MemoryCoordinator({
      repository: new MemoryRepository({
        ctx: new MockRuntimeDurableObjectState(),
      }),
      sessionMemoryClient,
    });

    const persisted = await coordinatorOne.extractAndPersist({
      runId: runIdOne,
      sessionId,
      source: "synthesis",
      phase: "synthesis",
      content: [
        "decision: Use strict runtime dependency injection for the engine.",
        "fact: Session memory is shared across runs in the same session.",
      ].join("\n"),
    });

    expect(persisted.some((event) => event.scope === "session")).toBe(true);
    expect(sessionMemoryClient.appendCount).toBeGreaterThan(0);

    const coordinatorTwo = new MemoryCoordinator({
      repository: new MemoryRepository({
        ctx: new MockRuntimeDurableObjectState(),
      }),
      sessionMemoryClient,
    });

    const sameSessionContext = await coordinatorTwo.retrieveContext({
      runId: runIdTwo,
      sessionId,
      prompt: "what did we decide about runtime dependency injection?",
      phase: "planning",
    });

    expect(
      sameSessionContext.relevantEvents.some((event) =>
        event.content.includes("strict runtime dependency injection"),
      ),
    ).toBe(true);

    const otherSessionContext = await coordinatorTwo.retrieveContext({
      runId: runIdTwo,
      sessionId: "session-isolated-memory",
      prompt: "runtime dependency injection",
      phase: "planning",
    });

    expect(otherSessionContext.relevantEvents).toHaveLength(0);
  });

  it("does not append to session-memory client when only run-scoped events are extracted", async () => {
    const coordinator = new MemoryCoordinator({
      repository: new MemoryRepository({
        ctx: new MockRuntimeDurableObjectState(),
      }),
      sessionMemoryClient,
    });

    const events = await coordinator.extractAndPersist({
      runId: "run_550e8400e29b41d4a716446655440003",
      sessionId: "session-run-scope-only",
      taskId: crypto.randomUUID(),
      source: "task",
      phase: "execution",
      content: [
        "constraint: Keep all runtime functions focused and deterministic.",
        "todo: add a focused integration test for session continuity.",
      ].join("\n"),
    });

    expect(events.every((event) => event.scope === "run")).toBe(true);
    expect(sessionMemoryClient.appendCount).toBe(0);
  });
});
