import { describe, expect, it } from "vitest";
import { MemoryRunRepository } from "./MemoryRunRepository.js";
import type { EnsureRunInput } from "./types.js";

describe("MemoryRunRepository", () => {
  it("can ensure a run exists and update its status", async () => {
    const repo = new MemoryRunRepository();
    const runId = "run-1";
    const input: EnsureRunInput = {
      id: runId,
      userId: "user-1",
      sessionId: "session-1",
      taskId: "task-1",
    };

    const run = await repo.ensureRun(input);
    expect(run.id).toBe(runId);
    expect(run.status).toBe("created");

    const updated = await repo.updateRunStatus({
      id: runId,
      status: "running",
      startedAt: new Date().toISOString(),
    });
    expect(updated.status).toBe("running");
    expect(updated.startedAt).toBeDefined();

    const fetched = await repo.getRun(runId);
    expect(fetched).toEqual(updated);
  });

  it("can append and list events for a run", async () => {
    const repo = new MemoryRunRepository();
    const runId = "run-2";
    await repo.ensureRun({
      id: runId,
      userId: "user-1",
      sessionId: "session-1",
      taskId: "task-1",
    });

    await repo.appendEvent({
      runId,
      sessionId: "session-1",
      eventType: "test.event",
      payload: { foo: "bar" },
    });

    await repo.appendEvent({
      runId,
      sessionId: "session-1",
      eventType: "test.event",
      payload: { baz: "qux" },
    });

    const events = await repo.listRunEvents(runId);
    expect(events).toHaveLength(2);
    expect(events[0]?.sequence).toBe(1);
    expect(events[1]?.sequence).toBe(2);
    expect(events[0]?.payload).toEqual({ foo: "bar" });
  });

  it("handles idempotency keys for events", async () => {
    const repo = new MemoryRunRepository();
    const runId = "run-3";
    const idempotencyKey = "key-123";

    const event1 = await repo.appendEvent({
      runId,
      sessionId: "session-1",
      eventType: "test.event",
      payload: { val: 1 },
      idempotencyKey,
    });

    const event2 = await repo.appendEvent({
      runId,
      sessionId: "session-1",
      eventType: "test.event",
      payload: { val: 2 },
      idempotencyKey,
    });

    expect(event1.id).toBe(event2.id);
    expect(event1.payload).toEqual({ val: 1 });
    const events = await repo.listRunEvents(runId);
    expect(events).toHaveLength(1);
  });
});
