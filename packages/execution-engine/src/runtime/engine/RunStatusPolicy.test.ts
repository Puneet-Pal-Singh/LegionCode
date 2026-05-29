import { describe, expect, it } from "vitest";
import { Task } from "../task/index.js";
import { Run } from "../run/index.js";
import {
  applyFinalRunStatus,
  determineRunStatusFromTasks,
  transitionRunToCompleted,
  transitionRunToFailed,
} from "./RunStatusPolicy.js";

describe("RunStatusPolicy", () => {
  it("returns RUNNING when any task is not terminal", () => {
    const tasks = [
      new Task("1", "run-1", "shell", "DONE", [], { description: "done" }),
      new Task("2", "run-1", "shell", "READY", [], { description: "ready" }),
    ];

    expect(determineRunStatusFromTasks(tasks)).toBe("RUNNING");
  });

  it("does not force a terminal transition when final status is RUNNING", () => {
    const run = new Run("run-1", "session-1", "RUNNING", "coding", {
      agentType: "coding",
      prompt: "check status",
      sessionId: "session-1",
    });

    applyFinalRunStatus(run, "run-1", "RUNNING", [
      new Task("1", "run-1", "shell", "READY", [], { description: "ready" }),
    ]);

    expect(run.status).toBe("RUNNING");
    expect(run.metadata.completedAt).toBeUndefined();
  });

  it("does not reactivate paused runs for later terminal transitions", () => {
    const completedRun = createPausedRun();
    const failedRun = createPausedRun();

    transitionRunToCompleted(completedRun, completedRun.id);
    transitionRunToFailed(failedRun, failedRun.id);

    expect(completedRun.status).toBe("PAUSED");
    expect(failedRun.status).toBe("PAUSED");
  });
});

function createPausedRun(): Run {
  return new Run("run-1", "session-1", "PAUSED", "coding", {
    agentType: "coding",
    prompt: "continue",
    sessionId: "session-1",
  });
}
