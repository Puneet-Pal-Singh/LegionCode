import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useStatusSync } from "./useStatusSync";

describe("useStatusSync", () => {
  it("keeps the local stop marker when stopping makes chat loading active", () => {
    const setLocallyStoppedRunId = vi.fn();
    const stop = vi.fn();
    const refetchGitStatus = vi.fn().mockResolvedValue(undefined);

    const { result, rerender } = renderHook(
      ({ isLoading }) =>
        useStatusSync({
          activeRunId: "run-123",
          canonicalRunStatus: "RUNNING",
          isApprovalWaitingRun: false,
          pendingApprovalRequestId: null,
          isStaleCanonicalActiveRun: false,
          isEffectiveCanonicalRunActive: true,
          isLoading,
          chatError: null,
          hasPendingApproval: false,
          isLocallyStoppedRun: false,
          setLocallyStoppedRunId,
          stop,
          refetchGitStatus,
        }),
      { initialProps: { isLoading: false } },
    );
    setLocallyStoppedRunId.mockClear();

    act(() => {
      result.current.handleStopRun();
    });
    rerender({ isLoading: true });

    expect(stop).toHaveBeenCalledTimes(1);
    expect(setLocallyStoppedRunId).toHaveBeenCalledWith("run-123");
    expect(setLocallyStoppedRunId).not.toHaveBeenCalledWith(null);
  });
});
