import { describe, expect, it } from "vitest";
import { RunRecovery, RunRecoveryError } from "./RunRecovery.js";
import { Run, RunRepository } from "../run/index.js";
import { Task, TaskRepository } from "../task/index.js";
import { MemoryCoordinator, MemoryRepository } from "../memory/index.js";
import type { RuntimeDurableObjectState, RuntimeStorage } from "../types.js";

const RUN_ID = "run_11111111111141118111111111111111";
const SESSION_ID = "session-recovery";

describe("RunRecovery", () => {
  it("replays from latest checkpoint with run and task context", async () => {
    const deps = createRecoveryDeps();
    await deps.runRepo.create(createRun("RUNNING"));
    await deps.taskRepo.create(
      new Task("task-1", RUN_ID, "shell", "DONE", [], {
        description: "First task",
      }),
    );
    await deps.memoryCoordinator.createCheckpoint({
      runId: RUN_ID,
      sequence: 1,
      phase: "execution",
      runStatus: "RUNNING",
      taskStatuses: { "task-1": "DONE" },
    });

    const replay = await deps.runRecovery.replayFromCheckpoint(
      RUN_ID,
      SESSION_ID,
    );

    expect(replay.run.id).toBe(RUN_ID);
    expect(replay.run.status).toBe("COMPLETED");
    expect(replay.tasks).toHaveLength(1);
    expect(replay.checkpoint.runId).toBe(RUN_ID);
    expect(replay.checkpoint.phase).toBe("execution");
    expect(replay.memoryContext.relevantEvents).toEqual([]);
  });

  it("rejects resume for terminal runs", async () => {
    const deps = createRecoveryDeps();
    await deps.runRepo.create(createRun("COMPLETED"));

    await expect(deps.runRecovery.resumeRun(RUN_ID, SESSION_ID)).rejects.toThrow(
      RunRecoveryError,
    );
    await expect(deps.runRecovery.resumeRun(RUN_ID, SESSION_ID)).rejects.toThrow(
      "Cannot resume run",
    );
  });

  it("reconstructs FAILED and CANCELLED states from task outcomes", async () => {
    const failedDeps = createRecoveryDeps();
    const failedRun = createRun("RUNNING");
    await failedDeps.runRepo.create(failedRun);
    await failedDeps.taskRepo.create(
      new Task("task-failed", RUN_ID, "shell", "FAILED", [], {
        description: "Fails",
      }),
    );
    await failedDeps.runRecovery.reconstructState(failedRun);
    const persistedFailed = await failedDeps.runRepo.getById(RUN_ID);
    expect(persistedFailed?.status).toBe("FAILED");
    expect(persistedFailed?.metadata.error).toBe("1 task(s) failed");

    const cancelledDeps = createRecoveryDeps(
      "run_22222222222242228222222222222222",
    );
    const cancelledRun = createRun(
      "RUNNING",
      "run_22222222222242228222222222222222",
    );
    await cancelledDeps.runRepo.create(cancelledRun);
    await cancelledDeps.taskRepo.create(
      new Task(
        "task-cancelled",
        "run_22222222222242228222222222222222",
        "shell",
        "CANCELLED",
        [],
        { description: "Cancelled" },
      ),
    );
    await cancelledDeps.runRecovery.reconstructState(cancelledRun);
    const persistedCancelled = await cancelledDeps.runRepo.getById(
      "run_22222222222242228222222222222222",
    );
    expect(persistedCancelled?.status).toBe("CANCELLED");
  });
});

function createRecoveryDeps(runId: string = RUN_ID) {
  const state = new MockRuntimeState();
  const runRepo = new RunRepository(state);
  const taskRepo = new TaskRepository(state);
  const memoryRepository = new MemoryRepository({ ctx: state });
  const memoryCoordinator = new MemoryCoordinator({ repository: memoryRepository });
  const runRecovery = new RunRecovery(runRepo, taskRepo, memoryCoordinator);

  return {
    runId,
    runRepo,
    taskRepo,
    memoryCoordinator,
    runRecovery,
  };
}

function createRun(
  status: "RUNNING" | "COMPLETED",
  runId: string = RUN_ID,
): Run {
  return new Run(runId, SESSION_ID, status, "coding", {
    agentType: "coding",
    prompt: "recover run state",
    sessionId: SESSION_ID,
  });
}

function cloneValue<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

class InMemoryStorage implements RuntimeStorage {
  private store = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.store.get(key);
    if (value === undefined) {
      return undefined;
    }
    return cloneValue(value as T);
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.store.set(key, cloneValue(value));
  }

  async delete(key: string | string[]): Promise<boolean | number> {
    if (Array.isArray(key)) {
      let deleted = 0;
      for (const entry of key) {
        if (this.store.delete(entry)) {
          deleted += 1;
        }
      }
      return deleted;
    }
    return this.store.delete(key);
  }

  async list<T>(options?: {
    prefix?: string;
    start?: string;
    end?: string;
    limit?: number;
  }): Promise<Map<string, T>> {
    const output = new Map<string, T>();
    const prefix = options?.prefix;
    const start = options?.start;
    const end = options?.end;
    const limit = options?.limit;
    const entries = [...this.store.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    );

    for (const [key, value] of entries) {
      if (prefix && !key.startsWith(prefix)) {
        continue;
      }
      if (start && key < start) {
        continue;
      }
      if (end && key >= end) {
        continue;
      }
      output.set(key, cloneValue(value as T));
      if (typeof limit === "number" && output.size >= limit) {
        break;
      }
    }

    return output;
  }
}

class MockRuntimeState implements RuntimeDurableObjectState {
  storage: RuntimeStorage = new InMemoryStorage();

  async blockConcurrencyWhile<T>(closure: () => Promise<T>): Promise<T> {
    return await closure();
  }
}
