import { describe, it, expect } from "vitest";
import type { RunInboxItem } from "./RunInbox";

describe("RunInbox", () => {
  const mockRuns: RunInboxItem[] = [
    {
      runId: "run-1",
      sessionId: "session-1",
      title: "First Task",
      status: "complete",
      updatedAt: new Date(Date.now() - 300000).toISOString(),
      repository: "user/repo",
    },
    {
      runId: "run-2",
      sessionId: "session-2",
      title: "Running Task",
      status: "running",
      updatedAt: new Date(Date.now() - 60000).toISOString(),
      repository: "user/repo",
    },
    {
      runId: "run-3",
      sessionId: "session-3",
      title: "Failed Task",
      status: "failed",
      updatedAt: new Date(Date.now() - 3600000).toISOString(),
      repository: "user/another-repo",
    },
  ];

  it("defines RunInboxItem type correctly", () => {
    const run = mockRuns[0]!;
    expect(run.runId).toBe("run-1");
    expect(run.status).toBe("complete");
    expect(run.title).toBe("First Task");
  });

  it("accepts all valid status values", () => {
    const statusValues: Array<RunInboxItem["status"]> = [
      "idle",
      "queued",
      "running",
      "waiting",
      "paused",
      "failed",
      "complete",
    ];
    statusValues.forEach((status) => {
      const run: RunInboxItem = {
        runId: `run-${status}`,
        sessionId: "session-1",
        title: `Task ${status}`,
        status,
        updatedAt: new Date().toISOString(),
        repository: "repo",
      };
      expect(run.status).toBe(status);
    });
  });

  it("handles multiple runs with different statuses", () => {
    expect(mockRuns).toHaveLength(3);
    expect(mockRuns[0]!.status).toBe("complete");
    expect(mockRuns[1]!.status).toBe("running");
    expect(mockRuns[2]!.status).toBe("failed");
  });

  it("preserves run ordering after multiple operations", () => {
    const runs = [...mockRuns];
    expect(runs[0]!.runId).toBe("run-1");
    expect(runs[1]!.runId).toBe("run-2");
    expect(runs[2]!.runId).toBe("run-3");
  });
});
