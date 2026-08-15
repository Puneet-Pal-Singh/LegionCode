import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalId, ItemId, TurnId } from "@repo/platform-client-sdk";
import type { LifecycleClient } from "../../../services/api/lifecycleClient";
import { createLifecycleProjection } from "../../../services/lifecycle/LifecycleProjection";
import { useApprovalController } from "./useApprovalController";

describe("useApprovalController", () => {
  it("dismisses an approval immediately after the canonical submission succeeds", async () => {
    const submitApproval = vi.fn().mockResolvedValue({});
    const { result } = renderHook(() =>
      useApprovalController({
        lifecycleProjection: pendingApprovalProjection(),
        lifecycleClient: { submitApproval } as unknown as LifecycleClient,
        sessionId: "session-1",
      }),
    );

    expect(result.current.pendingApproval).not.toBeNull();
    await act(() => result.current.resolve("allow_once"));

    expect(submitApproval).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "approved" }),
    );
    expect(result.current.pendingApproval).toBeNull();
  });

  it("keeps the approval visible when submission fails", async () => {
    const { result } = renderHook(() =>
      useApprovalController({
        lifecycleProjection: pendingApprovalProjection(),
        sessionId: "session-1",
        lifecycleClient: {
          submitApproval: vi.fn().mockRejectedValue(new Error("offline")),
        } as unknown as LifecycleClient,
      }),
    );

    await act(() => result.current.resolve("deny"));

    expect(result.current.pendingApproval).not.toBeNull();
    expect(result.current.error).toBe("offline");
  });

  it("does not let a resolved approval hide the same request in another chat", async () => {
    const { result, rerender } = renderHook(
      ({ sessionId }) =>
        useApprovalController({
          lifecycleProjection: pendingApprovalProjection(),
          lifecycleClient: {
            submitApproval: vi.fn().mockResolvedValue({}),
          } as unknown as LifecycleClient,
          sessionId,
        }),
      { initialProps: { sessionId: "session-1" } },
    );

    // A decision in session-1 must not suppress the same request identity in
    // session-2 after the chat surface switches.
    await act(() => result.current.resolve("allow_once"));
    rerender({ sessionId: "session-2" });
    expect(result.current.pendingApproval).not.toBeNull();
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
