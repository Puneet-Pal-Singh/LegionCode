// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createLifecycleProjection } from "@legioncode/sdk";
import type { TurnDiffPayload, TurnId } from "@legioncode/sdk";
import { useCompletedTurnReview } from "./useCompletedTurnReview.js";

describe("useCompletedTurnReview", () => {
  it("does not synthesize review files before terminal canonical diff settlement", async () => {
    const { result } = renderHook(() =>
      useCompletedTurnReview(
        createLifecycleProjection("trn_review001" as TurnId),
        null,
      ),
    );

    expect(result.current.files).toEqual([]);
    expect(result.current.error).toBeNull();
    await expect(result.current.loadFileDiff({
      path: "src/app.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      isStaged: false,
    })).rejects.toThrow("canonical turn diff");
  });

  it("surfaces a terminal projection without its canonical diff as an error", async () => {
    const projection = {
      ...createLifecycleProjection("trn_review002" as TurnId),
      terminal: {
        state: "completed" as const,
        eventId: "evt_terminal",
        content: "Done",
        occurredAt: "2026-07-10T00:00:00.000Z",
      },
    };
    const { result } = renderHook(() =>
      useCompletedTurnReview(projection, "assistant-1"),
    );

    expect(result.current.error).toBe("Saved changes are unavailable for this reply.");
    expect(result.current.messageId).toBe("assistant-1");

    const { result: conversationReview } = renderHook(() =>
      useCompletedTurnReview(
        { ...projection, executionCapability: "conversation" },
        "assistant-conversation",
      ),
    );
    expect(conversationReview.current.error).toBeNull();
    expect(conversationReview.current.turnId).toBeNull();
    expect(conversationReview.current.files).toEqual([]);

    const captured: TurnDiffPayload = {
      turnId: projection.turnId,
      startSnapshot: { turnId: projection.turnId, snapshotKey: "start", treeId: "a".repeat(40),
        headSha: "b".repeat(40), phase: "start", capturedAt: "2026-07-10T00:00:00.000Z" },
      terminalSnapshot: { turnId: projection.turnId, snapshotKey: "terminal", treeId: "c".repeat(40),
        headSha: "b".repeat(40), phase: "terminal", capturedAt: "2026-07-10T00:00:01.000Z" },
      files: [{ path: "src/app.ts", status: "modified", additions: 1, deletions: 1, previousPath: null }],
      patch: "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-before\n+after\n",
    };
    for (const state of ["failed", "interrupted"] as const) {
      const settled = { ...projection, terminal: { ...projection.terminal, state },
        workspaceSnapshotState: "captured" as const, turnDiff: captured };
      const { result: review, rerender } = renderHook(
        ({ diff }: { diff: TurnDiffPayload }) => useCompletedTurnReview({ ...settled, turnDiff: diff }, "saved-reply"),
        { initialProps: { diff: captured } },
      );
      expect(review.current.turnId).toBe(projection.turnId);
      expect(review.current.error).toBeNull();
      expect(review.current.files.map((file) => file.path)).toEqual(["src/app.ts"]);
      expect((await review.current.loadFileDiff(review.current.files[0]!)).hunks[0]?.lines)
        .toEqual(expect.arrayContaining([expect.objectContaining({ type: "added", content: "+after" })]));
      rerender({ diff: { ...captured, turnId: "trn_anotherreview" as TurnId } });
      expect(review.current.files).toEqual([]);
      expect(review.current.error).toBe("Saved changes are unavailable for this reply.");
      await expect(review.current.loadFileDiff({ path: "src/app.ts", status: "modified", additions: 1,
        deletions: 1, isStaged: false })).rejects.toThrow("captured canonical turn diff");
    }
  });
});

afterEach(cleanup);
