import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalId, ItemId, TurnId } from "@repo/platform-client-sdk";
import type { LifecycleClient } from "../../../services/api/lifecycleClient";
import { createLifecycleProjection } from "../../../services/lifecycle/LifecycleProjection";
import { useApprovalController } from "./useApprovalController";

describe("useApprovalController", () => {
  it("dismisses an approval immediately after the canonical submission succeeds", async () => {
    const submitApproval = vi.fn().mockResolvedValue({});
    const onPendingApprovalChange = vi.fn();
    const { result } = renderHook(() =>
      useApprovalController({
        lifecycleProjection: pendingApprovalProjection(),
        lifecycleClient: { submitApproval } as unknown as LifecycleClient,
        onPendingApprovalChange,
      }),
    );

    expect(result.current.pendingApproval).not.toBeNull();
    await act(() => result.current.resolve("allow_once"));

    expect(submitApproval).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "approved" }),
    );
    expect(result.current.pendingApproval).toBeNull();
    await waitFor(() =>
      expect(onPendingApprovalChange).toHaveBeenLastCalledWith(false),
    );
  });

  it("keeps the approval visible when submission fails", async () => {
    const { result } = renderHook(() =>
      useApprovalController({
        lifecycleProjection: pendingApprovalProjection(),
        lifecycleClient: {
          submitApproval: vi.fn().mockRejectedValue(new Error("offline")),
        } as unknown as LifecycleClient,
      }),
    );

    await act(() => result.current.resolve("deny"));

    expect(result.current.pendingApproval).not.toBeNull();
    expect(result.current.error).toBe("offline");
  });

  it("clears transient approval state when the chat surface unmounts", () => {
    const onPendingApprovalChange = vi.fn();
    const { unmount } = renderHook(() =>
      useApprovalController({
        lifecycleProjection: pendingApprovalProjection(),
        lifecycleClient: {} as LifecycleClient,
        onPendingApprovalChange,
      }),
    );

    expect(onPendingApprovalChange).toHaveBeenLastCalledWith(true);
    unmount();
    expect(onPendingApprovalChange).toHaveBeenLastCalledWith(false);
  });
});

function pendingApprovalProjection() {
  const turnId = "trn_approval01" as TurnId;
  return {
    ...createLifecycleProjection(turnId),
    pendingApproval: {
      approvalId: "appr_approval01" as ApprovalId,
      itemId: "item_approval01" as ItemId,
      question: "Allow git status?",
      options: ["allow", "deny"],
      requestedAt: "2026-08-09T12:00:00.000Z",
      decidedAt: null,
      decision: null,
    },
  };
}
