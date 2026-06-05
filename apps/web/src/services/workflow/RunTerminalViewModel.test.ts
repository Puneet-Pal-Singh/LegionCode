import { describe, expect, it } from "vitest";
import { RUN_EVENT_TYPES, type RunEvent } from "@repo/shared-types";
import { buildRunTerminalViewModel } from "./RunTerminalViewModel";

describe("buildRunTerminalViewModel", () => {
  it("builds a completed terminal card with metadata fields", () => {
    const viewModel = buildRunTerminalViewModel({
      runId: "run-1",
      summary: {
        status: "COMPLETED",
        terminalState: "completed",
        terminalMessage: {
          artifactId: "artifact-1",
          changedFileCount: 2,
          lastSuccessfulStep: "create_code_artifact",
          nextAction: "Send the next task when ready.",
        },
      },
      events: [],
      hasVisibleAssistantMessage: false,
    });

    expect(viewModel?.artifactId).toBe("artifact-1");
    expect(viewModel?.content).toContain("Run completed.");
    expect(viewModel?.content).toContain("2 files changed.");
    expect(viewModel?.content).toContain(
      "Last successful step: create_code_artifact",
    );
    expect(viewModel?.content).toContain("Send the next task when ready.");
  });

  it("does not suppress approval-required as a generic failure", () => {
    const viewModel = buildRunTerminalViewModel({
      runId: "run-approval",
      summary: {
        status: "WAITING",
        pendingApproval: { requestId: "req-1" },
      },
      events: [],
      hasVisibleAssistantMessage: false,
    });

    expect(viewModel?.state).toBe("approval_required");
    expect(viewModel?.content).toContain("Approval is required");
  });

  it("suppresses no-op completed terminal cards", () => {
    const viewModel = buildRunTerminalViewModel({
      runId: "run-noop",
      summary: {
        status: "COMPLETED",
        terminalState: "completed",
        terminalMessage: {
          changedFileCount: 0,
          nextAction: "Send the next task when you are ready.",
        },
      },
      events: [],
      hasVisibleAssistantMessage: false,
    });

    expect(viewModel).toBeNull();
  });

  it("shows completed and failed work for failed runs", () => {
    const events: RunEvent[] = [
      {
        version: 1,
        eventId: "evt-1",
        runId: "run-failed",
        sessionId: "session-1",
        timestamp: "2026-06-03T00:00:00.000Z",
        source: "brain",
        type: RUN_EVENT_TYPES.TOOL_COMPLETED,
        payload: {
          toolId: "tool-1",
          toolName: "read_file",
          result: "ok",
          executionTimeMs: 10,
        },
      },
      {
        version: 1,
        eventId: "evt-2",
        runId: "run-failed",
        sessionId: "session-1",
        timestamp: "2026-06-03T00:00:01.000Z",
        source: "brain",
        type: RUN_EVENT_TYPES.TOOL_FAILED,
        payload: {
          toolId: "tool-2",
          toolName: "npm_test",
          error: "failed",
          executionTimeMs: 10,
        },
      },
    ];

    const viewModel = buildRunTerminalViewModel({
      runId: "run-failed",
      summary: {
        status: "FAILED",
        terminalState: "failed_tool",
      },
      events,
      hasVisibleAssistantMessage: false,
      changedFileCount: 1,
    });

    expect(viewModel?.content).toContain("1 file changed.");
    expect(viewModel?.content).toContain("Last successful step: read_file");
    expect(viewModel?.content).toContain("Failed step: npm_test");
  });
});
