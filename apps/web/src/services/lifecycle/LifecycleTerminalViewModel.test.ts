import { describe, expect, it } from "vitest";
import type { TurnId } from "../api/lifecycleClient";
import {
  buildLifecycleTerminalViewModel,
  collectLifecycleTurnDiffFiles,
} from "./LifecycleTerminalViewModel";
import type { LifecycleProjection } from "./LifecycleProjection";

const TURN_ID = "trn_view01" as TurnId;

describe("LifecycleTerminalViewModel", () => {
  it("renders terminal failure content from canonical terminal projection", () => {
    const terminal = buildLifecycleTerminalViewModel({
      ...emptyProjection(),
      terminal: {
        state: "failed",
        eventId: "evt_terminal001",
        content: "Turn failed: tool failure",
        occurredAt: "2026-06-23T00:00:00.000Z",
      },
    });

    expect(terminal).toEqual({
      id: `terminal:${TURN_ID}`,
      state: "failed_runtime",
      content: "Turn failed: tool failure",
      artifactId: null,
    });
  });

  it("uses canonical turn diff files for review summaries", () => {
    const files = collectLifecycleTurnDiffFiles({
      ...emptyProjection(),
      turnDiff: {
        turnId: TURN_ID,
        startSnapshot: {
          turnId: TURN_ID,
          snapshotKey: "start",
          treeId: "a".repeat(40),
          headSha: "b".repeat(40),
          phase: "start",
          capturedAt: "2026-06-23T00:00:00.000Z",
        },
        terminalSnapshot: {
          turnId: TURN_ID,
          snapshotKey: "terminal",
          treeId: "c".repeat(40),
          headSha: "d".repeat(40),
          phase: "terminal",
          capturedAt: "2026-06-23T00:00:01.000Z",
        },
        files: [
          {
            path: "src/index.ts",
            status: "modified",
            additions: 3,
            deletions: 1,
            previousPath: null,
          },
        ],
        patch: "diff --git a/src/index.ts b/src/index.ts\n",
      },
    });

    expect(files).toEqual([
      {
        path: "src/index.ts",
        status: "modified",
        additions: 3,
        deletions: 1,
        isStaged: false,
      },
    ]);
  });
});

function emptyProjection(): LifecycleProjection {
  return {
    turnId: TURN_ID,
    lastSequence: 0,
    items: [],
    pendingApproval: null,
    terminal: null,
    turnDiff: null,
    activeThinking: false,
    assistantText: "",
  };
}
