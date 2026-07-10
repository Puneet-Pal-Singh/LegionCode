import { describe, expect, it, vi } from "vitest";
import type { DiffContent, FileStatus } from "@repo/shared-types";
import type { TurnDiffPayload, TurnId } from "../../../services/api/lifecycleClient";
import {
  resolveTerminalChangedFilesSummary,
  shouldAllowFallbackChangedFileDiff,
  shouldRenderLiveChangedFileSnapshots,
} from "./changedFiles";

const TURN_ID = "trn_changedfiles001" as TurnId;
const FILE: FileStatus = {
  path: "src/index.ts",
  status: "modified",
  additions: 1,
  deletions: 1,
  isStaged: false,
};

describe("changedFiles terminal review projection", () => {
  it("only keeps live snapshot fallback while the turn is still active", () => {
    expect(
      shouldRenderLiveChangedFileSnapshots({
        isLoading: true,
        turnDiff: null,
      }),
    ).toBe(true);
    expect(
      shouldRenderLiveChangedFileSnapshots({
        isLoading: false,
        turnDiff: null,
      }),
    ).toBe(false);
    expect(
      shouldRenderLiveChangedFileSnapshots({
        isLoading: true,
        turnDiff: turnDiff(""),
      }),
    ).toBe(false);
  });

  it("rejects completed-turn diff fallback when canonical sources are missing", () => {
    expect(
      shouldAllowFallbackChangedFileDiff({
        isLoading: true,
        turnDiff: null,
        hasArtifact: false,
      }),
    ).toBe(true);
    expect(
      shouldAllowFallbackChangedFileDiff({
        isLoading: false,
        turnDiff: null,
        hasArtifact: false,
      }),
    ).toBe(false);
    expect(
      shouldAllowFallbackChangedFileDiff({
        isLoading: false,
        turnDiff: null,
        hasArtifact: true,
      }),
    ).toBe(false);
  });

  it("loads terminal review diffs from the canonical turn diff source", async () => {
    const loadArtifactFileDiff = vi.fn(async (): Promise<DiffContent> => {
      throw new Error("artifact diff should not be used");
    });
    const summary = resolveTerminalChangedFilesSummary({
      terminalViewModel: {
        id: `terminal:${TURN_ID}`,
        state: "completed",
        content: "Done.",
        artifactId: null,
      },
      files: [FILE],
      turnDiff: turnDiff(`diff --git a/src/index.ts b/src/index.ts
--- a/src/index.ts
+++ b/src/index.ts
@@ -1 +1 @@
-old value
+new value`),
      loadArtifactFileDiff,
      onPromptArtifactReview: vi.fn(),
      onReviewOpen: vi.fn(),
    });

    expect(summary?.files).toEqual([FILE]);

    const diff = await summary?.loadFileDiff(FILE);

    expect(loadArtifactFileDiff).not.toHaveBeenCalled();
    expect(diff?.hunks[0]?.lines).toEqual([
      { type: "deleted", content: "-old value", oldLineNumber: 1 },
      { type: "added", content: "+new value", newLineNumber: 1 },
    ]);
  });

  it("fails terminal review diff rendering when canonical turn diff is missing", async () => {
    const summary = resolveTerminalChangedFilesSummary({
      terminalViewModel: {
        id: `terminal:${TURN_ID}`,
        state: "completed",
        content: "Done.",
        artifactId: null,
      },
      files: [FILE],
      turnDiff: null,
      loadArtifactFileDiff: vi.fn(),
      onPromptArtifactReview: vi.fn(),
      onReviewOpen: vi.fn(),
    });

    await expect(summary?.loadFileDiff(FILE)).rejects.toThrow(
      "Canonical turn diff is required to render src/index.ts",
    );
  });
});

function turnDiff(patch: string): TurnDiffPayload {
  return {
    turnId: TURN_ID,
    startSnapshot: {
      turnId: TURN_ID,
      snapshotKey: "start",
      treeId: "a".repeat(40),
      headSha: "b".repeat(40),
      phase: "start",
      capturedAt: "2026-07-04T00:00:00.000Z",
    },
    terminalSnapshot: {
      turnId: TURN_ID,
      snapshotKey: "terminal",
      treeId: "c".repeat(40),
      headSha: "d".repeat(40),
      phase: "terminal",
      capturedAt: "2026-07-04T00:00:01.000Z",
    },
    files: [
      {
        path: FILE.path,
        status: "modified",
        additions: FILE.additions ?? 0,
        deletions: FILE.deletions ?? 0,
        previousPath: null,
      },
    ],
    patch,
  };
}
