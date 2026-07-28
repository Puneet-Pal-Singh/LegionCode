import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useStatusSync } from "./useStatusSync";

describe("useStatusSync", () => {
  it("publishes terminal status only from the canonical run status", () => {
    const stop = vi.fn();
    const refetchGitStatus = vi.fn().mockResolvedValue(undefined);
    const onSessionStatusChange = vi.fn();

    const { result } = renderHook(() =>
      useStatusSync({
        activeRunId: "run-123",
        canonicalRunStatus: "CANCELLED",
        isApprovalWaitingRun: false,
        pendingApprovalRequestId: null,
        isEffectiveCanonicalRunActive: false,
        chatError: null,
        stop,
        refetchGitStatus,
        onSessionStatusChange,
      }),
    );

    result.current.handleStopRun();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(onSessionStatusChange).toHaveBeenCalledWith("completed");
    expect(onSessionStatusChange).not.toHaveBeenCalledWith("running");
  });
});
