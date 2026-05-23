import { renderHook, waitFor } from "@testing-library/react";
import type { Message } from "@ai-sdk/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentStore } from "../store/agentStore";
import { useChatPersistence } from "./useChatPersistence";

describe("useChatPersistence", () => {
  beforeEach(() => {
    localStorage.clear();
    agentStore.clearAllMessages();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not replay a pending query before transcript hydration completes", async () => {
    localStorage.setItem("shadowbox:pending-query:session-1", "hi");
    const append = vi.fn<[{ role: "user"; content: string }], Promise<void>>(
      async () => undefined,
    );

    const { rerender } = renderHook(
      ({ hasHydrated }) =>
        useChatPersistence({
          sessionId: "session-1",
          runId: "run-1",
          messages: [],
          messagesLength: 0,
          isLoading: false,
          hasHydrated,
          isModelConfigReady: true,
          append,
        }),
      { initialProps: { hasHydrated: false } },
    );

    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(append).not.toHaveBeenCalled();

    rerender({ hasHydrated: true });

    await waitFor(() => {
      expect(append).toHaveBeenCalledWith({ role: "user", content: "hi" });
    });
  });

  it("retries a pending query restore after retryable append failure", async () => {
    localStorage.setItem("shadowbox:pending-query:session-1", "retry me");
    const append = vi
      .fn<[{ role: "user"; content: string }], Promise<void>>()
      .mockRejectedValueOnce(new Error("HTTP 503"))
      .mockResolvedValueOnce(undefined);

    renderHook(() =>
      useChatPersistence({
        sessionId: "session-1",
        runId: "run-1",
        messages: [],
        messagesLength: 0,
        isLoading: false,
        hasHydrated: true,
        isModelConfigReady: true,
        append,
      }),
    );

    await waitFor(() => {
      expect(append).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(append).toHaveBeenCalledTimes(2);
    }, { timeout: 1500 });
    expect(localStorage.getItem("shadowbox:pending-query:session-1")).toBeNull();
  });

  it("syncs empty message arrays to clear stale agent store entries", async () => {
    const oldMessage = {
      id: "old-message",
      role: "assistant",
      content: "stale",
    } satisfies Message;
    agentStore.setMessages("run-1", [oldMessage]);

    renderHook(() =>
      useChatPersistence({
        sessionId: "session-1",
        runId: "run-1",
        messages: [],
        messagesLength: 0,
        isLoading: false,
        hasHydrated: false,
        isModelConfigReady: true,
        append: vi.fn(),
      }),
    );

    await waitFor(() => {
      expect(agentStore.getMessages("run-1")).toEqual([]);
    });
  });
});
