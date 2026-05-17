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

  it("can upsert and list steps for a run", async () => {
    const repo = new MemoryRunRepository();
    const runId = "run-steps";
    await repo.ensureRun({
      id: runId,
      userId: "user-1",
      sessionId: "session-1",
      taskId: "task-1",
    });

    const first = await repo.upsertStep({
      runId,
      stepIndex: 1,
      stepType: "tool.started",
      status: "running",
      startedAt: "2026-05-13T00:00:00.000Z",
      payload: { toolName: "read_file" },
    });
    const retried = await repo.upsertStep({
      runId,
      stepIndex: 1,
      stepType: "tool.completed",
      status: "completed",
      completedAt: "2026-05-13T00:00:01.000Z",
      payload: { toolName: "read_file" },
    });

    expect(retried.id).toBe(first.id);
    expect(retried.status).toBe("completed");
    expect(retried.startedAt).toBe(first.startedAt);
    await expect(repo.listRunSteps(runId, "user-1")).resolves.toHaveLength(1);
  });

  it("scopes run reads by user", async () => {
    const repo = new MemoryRunRepository();
    await repo.ensureRun({
      id: "run-owned",
      userId: "user-owner",
      sessionId: "session-1",
      taskId: "task-1",
    });

    await expect(repo.getRun("run-owned", "other-user")).resolves.toBeNull();
    await expect(repo.listRunEvents("run-owned", "other-user")).resolves.toEqual(
      [],
    );
  });

  it("supports transactional operations", async () => {
    const repo = new MemoryRunRepository();
    const runId = "run-tx";

    const result = await repo.transaction(async (txRepo) => {
      const run = await txRepo.ensureRun({
        id: runId,
        userId: "user-tx",
        sessionId: "session-tx",
        taskId: "task-tx",
      });
      return run.id;
    });

    expect(result).toBe(runId);
    const fetched = await repo.getRun(runId);
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(runId);
  });

  it("handles idempotency keys for events", async () => {
    const repo = new MemoryRunRepository();
    const runId = "run-3";
    const idempotencyKey = "key-123";

    await repo.ensureRun({
      id: runId,
      userId: "user-1",
      sessionId: "session-1",
      taskId: "task-1",
    });

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
