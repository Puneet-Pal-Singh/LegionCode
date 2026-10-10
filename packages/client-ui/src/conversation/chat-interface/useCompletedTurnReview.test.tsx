// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createLifecycleProjection } from "@legioncode/sdk";
import type { TurnId } from "@legioncode/sdk";
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

  it("surfaces a terminal projection without its canonical diff as an error", () => {
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

    expect(result.current.error).toContain("canonical turn diff");
    expect(result.current.messageId).toBe("assistant-1");
  });
});

afterEach(cleanup);
