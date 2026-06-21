import { describe, expect, it } from "vitest";
import { RUN_EVENT_TYPES } from "@repo/shared-types";
import type {
  RunCompletedEvent,
  RunFailedEvent,
  ToolCompletedEvent,
} from "@repo/shared-types";
import {
  EditArtifactRunCaptureCoordinator,
  type EditArtifactCaptureService,
  extractChangedFileFromToolResult,
  mergePromptChangedFilesWithGitStats,
} from "./EditArtifactCaptureService";

describe("EditArtifactCaptureService helpers", () => {
  it("extracts edit stats from top-level tool activity metadata", () => {
    const changedFile = extractChangedFileFromToolResult({
      content: "Updated src/hero.tsx",
      metadata: {
        activity: {
          family: "edit",
          filePath: "src/hero.tsx",
          additions: 12,
          deletions: 4,
        },
      },
    });

    expect(changedFile).toEqual({
      path: "src/hero.tsx",
      status: "modified",
      additions: 12,
      deletions: 4,
    });
  });

  it("extracts edit stats from nested tool output metadata", () => {
    const changedFile = extractChangedFileFromToolResult({
      output: {
        metadata: {
          activity: {
            family: "edit",
            filePath: "src/hero.tsx",
            additions: 3,
            deletions: 1,
          },
        },
      },
    });

    expect(changedFile).toMatchObject({
      path: "src/hero.tsx",
      additions: 3,
      deletions: 1,
    });
  });

  it("keeps prompt file scope while enriching matching git stats", () => {
    const changedFiles = mergePromptChangedFilesWithGitStats(
      [{ path: "src/hero.tsx", status: "modified" }],
      [
        {
          path: "src/hero.tsx",
          status: "modified",
          additions: 8,
          deletions: 2,
          isStaged: false,
        },
        {
          path: "src/footer.tsx",
          status: "modified",
          additions: 1,
          deletions: 1,
          isStaged: false,
        },
      ],
    );

    expect(changedFiles).toEqual([
      {
        path: "src/hero.tsx",
        status: "modified",
        additions: 8,
        deletions: 2,
        isStaged: false,
      },
    ]);
  });

  it("binds captured patches to the persisted assistant message before capture", async () => {
    const captures: Array<
      Parameters<EditArtifactCaptureService["captureAfterRunMutation"]>[0]
    > = [];
    const service = {
      captureBaseline: async () => "a".repeat(40),
      captureAfterRunMutation: async (
        input: Parameters<
          EditArtifactCaptureService["captureAfterRunMutation"]
        >[0],
      ) => {
        captures.push(input);
      },
    };
    const coordinator = new EditArtifactRunCaptureCoordinator(service, {
      userId: "user-1",
      runId: "run-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      muscleSession: "run-1",
      repoOwner: "owner",
      repoName: "repo",
      repoUrl: "https://github.com/owner/repo",
    });

    await coordinator.prepare();
    coordinator.handleEvent(createWriteFileCompletedEvent());
    coordinator.handleEvent(
      createWriteFileCompletedEvent("canonical_edit_tool", "src/footer.tsx"),
    );
    coordinator.handleEvent(createRunCompletedEvent());
    coordinator.setMessageContext({ assistantMessageId: "assistant-1" });

    await coordinator.waitForPendingCapture();

    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({
      assistantMessageId: "assistant-1",
      baselineTree: "a".repeat(40),
      changedFiles: [
        {
          path: "src/hero.tsx",
          status: "modified",
          additions: 2,
          deletions: 1,
        },
        {
          path: "src/footer.tsx",
          status: "modified",
          additions: 2,
          deletions: 1,
        },
      ],
    });
  });

  it("does not capture an artifact for a failed turn without edit metadata", async () => {
    const captureAfterRunMutation = vi.fn();
    const coordinator = new EditArtifactRunCaptureCoordinator(
      {
        captureBaseline: async () => "a".repeat(40),
        captureAfterRunMutation,
      },
      {
        userId: "user-1",
        runId: "run-1",
        sessionId: "session-1",
        workspaceId: "workspace-1",
        muscleSession: "run-1",
        repoOwner: "owner",
        repoName: "repo",
        repoUrl: "https://github.com/owner/repo",
      },
    );

    await coordinator.prepare();
    coordinator.handleEvent(createRunFailedEvent());
    await coordinator.waitForPendingCapture();

    expect(captureAfterRunMutation).not.toHaveBeenCalled();
  });
});

function createWriteFileCompletedEvent(
  toolName = "write_file",
  filePath = "src/hero.tsx",
): ToolCompletedEvent {
  return {
    version: 1,
    eventId: "event-tool-1",
    runId: "run-1",
    sessionId: "session-1",
    timestamp: "2026-06-01T00:00:00.000Z",
    source: "brain",
    type: RUN_EVENT_TYPES.TOOL_COMPLETED,
    payload: {
      toolId: "tool-1",
      toolName,
      executionTimeMs: 1,
      result: {
        metadata: {
          activity: {
            family: "edit",
            filePath,
            additions: 2,
            deletions: 1,
          },
        },
      },
    },
  };
}

function createRunCompletedEvent(): RunCompletedEvent {
  return {
    version: 1,
    eventId: "event-run-1",
    runId: "run-1",
    sessionId: "session-1",
    timestamp: "2026-06-01T00:00:01.000Z",
    source: "brain",
    type: RUN_EVENT_TYPES.RUN_COMPLETED,
    payload: {
      status: "complete",
      totalDurationMs: 1,
      toolsUsed: 1,
    },
  };
}

function createRunFailedEvent(): RunFailedEvent {
  return {
    version: 1,
    eventId: "event-run-failed-1",
    runId: "run-1",
    sessionId: "session-1",
    timestamp: "2026-06-01T00:00:01.000Z",
    source: "brain",
    type: RUN_EVENT_TYPES.RUN_FAILED,
    payload: {
      status: "failed",
      error: "Approval expired",
      totalDurationMs: 1,
    },
  };
}
