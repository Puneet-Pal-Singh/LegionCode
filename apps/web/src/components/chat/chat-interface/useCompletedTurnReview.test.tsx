import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createLifecycleProjection } from "../../../services/lifecycle/LifecycleProjection";
import type { TurnId } from "../../../services/api/lifecycleClient";
import { useCompletedTurnReview } from "./useCompletedTurnReview";

describe("useCompletedTurnReview", () => {
  it("does not synthesize review files before terminal canonical diff settlement", async () => {
    const { result } = renderHook(() =>
      useCompletedTurnReview(
        createLifecycleProjection("trn_review001" as TurnId),
      ),
    );

    expect(result.current.files).toEqual([]);
    await expect(result.current.loadFileDiff({
      path: "src/app.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      isStaged: false,
    })).rejects.toThrow("canonical turn diff");
  });
});
