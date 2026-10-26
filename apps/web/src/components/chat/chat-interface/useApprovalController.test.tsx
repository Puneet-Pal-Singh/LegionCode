import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalId, ItemId, TurnId } from "@legioncode/sdk";
import type { LifecycleProjectionApproval, PlatformClient } from "@legioncode/sdk";
import { createLifecycleProjection } from "@legioncode/sdk";
import { useApprovalController } from "./useApprovalController";

describe("useApprovalController", () => {
  it("dismisses an approval immediately after the canonical submission succeeds", async () => {
    const submitLifecycleApproval = vi.fn().mockResolvedValue({});
    const { result } = renderHook(() =>
      useApprovalController({
        lifecycleProjection: pendingApprovalProjection(),
        lifecycleClient: { submitLifecycleApproval } as unknown as Pick<PlatformClient, "submitLifecycleApproval">,
        sessionId: "session-1",
      }),
    );

    expect(result.current.pendingApproval).not.toBeNull();
    expect(result.current.pendingApproval?.category).toBe("network_external");
    await act(() => result.current.resolve("allow_once"));

    expect(submitLifecycleApproval).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "approved", grantScope: "once" }),
    );
    expect(result.current.pendingApproval).toBeNull();
  });

  it("offers chat-scoped approval only when the canonical option is present", async () => {
    const submitLifecycleApproval = vi.fn().mockResolvedValue({});
    const { result } = renderHook(() =>
      useApprovalController({
        lifecycleProjection: pendingApprovalProjection([
          ...DEFAULT_APPROVAL_OPTIONS,
          {
            id: "allow_matching_in_chat",
            label: "Always allow in this chat",
            description: "Reuse this approval in the current chat.",
          },
        ]),
        lifecycleClient: { submitLifecycleApproval } as unknown as Pick<PlatformClient, "submitLifecycleApproval">,
        sessionId: "session-1",
      }),
    );

    expect(result.current.matchingInChatOption).toEqual({
      id: "allow_matching_in_chat",
      label: "Always allow in this chat",
      description: "Reuse this approval in the current chat.",
    });
    expect(result.current.decisions).toContain("allow_persistent_rule");
    await act(() => result.current.resolve("allow_persistent_rule"));
    expect(submitLifecycleApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "approved",
        grantScope: "matching_in_chat",
      }),
    );
  });

  it("does not expose chat-scoped approval when the canonical option is absent", () => {
    const { result } = renderHook(() =>
      useApprovalController({
        lifecycleProjection: pendingApprovalProjection(),
        lifecycleClient: {
          submitLifecycleApproval: vi.fn().mockResolvedValue({}),
        } as unknown as Pick<PlatformClient, "submitLifecycleApproval">,
        sessionId: "session-1",
      }),
    );

    expect(result.current.matchingInChatOption).toBeNull();
    expect(result.current.decisions).not.toContain("allow_persistent_rule");
  });

  it("shows only deny and abort when those are the canonical options", () => {
    const { result } = renderHook(() =>
      useApprovalController({
        lifecycleProjection: pendingApprovalProjection([
          { id: "deny", label: "Deny", description: null },
          { id: "abort", label: "Abort", description: null },
        ]),
        lifecycleClient: {
          submitLifecycleApproval: vi.fn().mockResolvedValue({}),
        } as unknown as Pick<PlatformClient, "submitLifecycleApproval">,
        sessionId: "session-1",
      }),
    );

    expect(result.current.decisions).toEqual(["deny", "abort"]);
  });

  it("keeps the approval visible when submission fails", async () => {
    const submitLifecycleApproval = vi.fn().mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() =>
      useApprovalController({
        lifecycleProjection: pendingApprovalProjection(),
        sessionId: "session-1",
        lifecycleClient: { submitLifecycleApproval } as unknown as Pick<PlatformClient, "submitLifecycleApproval">,
      }),
    );

    await act(() => result.current.resolve("deny"));

    expect(submitLifecycleApproval).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "denied" }),
    );
    expect(submitLifecycleApproval.mock.calls[0]?.[0]).not.toHaveProperty("grantScope");
    expect(result.current.pendingApproval).not.toBeNull();
    expect(result.current.error).toBe("offline");
  });

  it("does not let a resolved approval hide the same request in another chat", async () => {
    const { result, rerender } = renderHook(
      ({ sessionId }) =>
        useApprovalController({
          lifecycleProjection: pendingApprovalProjection(),
          lifecycleClient: {
            submitLifecycleApproval: vi.fn().mockResolvedValue({}),
          } as unknown as Pick<PlatformClient, "submitLifecycleApproval">,
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

const DEFAULT_APPROVAL_OPTIONS: LifecycleProjectionApproval["options"] = [
  { id: "allow_once", label: "Allow once", description: null },
  { id: "deny", label: "Deny", description: null },
];

function pendingApprovalProjection(
  options: LifecycleProjectionApproval["options"] = DEFAULT_APPROVAL_OPTIONS,
) {
  const turnId = "trn_approval01" as TurnId;
  return {
    ...createLifecycleProjection(turnId),
    pendingApproval: {
      approvalId: "appr_approval01" as ApprovalId,
      itemId: "item_approval01" as ItemId,
      question: "Allow git status?",
      metadata: { category: "network_external" },
      options,
      requestedAt: "2026-08-09T12:00:00.000Z",
      decidedAt: null,
      decision: null,
    },
  };
}
