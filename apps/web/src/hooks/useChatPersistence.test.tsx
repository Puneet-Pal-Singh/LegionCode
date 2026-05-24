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

  it("replays a pending query immediately for a new empty session", async () => {
    localStorage.setItem("shadowbox:pending-query:session-1", "hi");
    const append = vi.fn<[{ role: "user"; content: string }], Promise<void>>(
      async () => undefined,
    );

    renderHook(() =>
      useChatPersistence({
        sessionId: "session-1",
        runId: "run-1",
        messages: [],
        messagesLength: 0,
        isLoading: false,
        isModelConfigReady: true,
        allowPendingQueryRestore: true,
        append,
      }),
    );

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
        isModelConfigReady: true,
        allowPendingQueryRestore: true,
        append,
      }),
    );

    await waitFor(() => {
      expect(append).toHaveBeenCalledTimes(1);
    });
    expect(localStorage.getItem("shadowbox:pending-query:session-1")).toBeNull();

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
        isModelConfigReady: true,
        allowPendingQueryRestore: true,
        append: vi.fn(),
      }),
    );

    await waitFor(() => {
      expect(agentStore.getMessages("run-1")).toEqual([]);
    });
  });

  it("does not replay a claimed pending query after switching scopes", async () => {
    localStorage.setItem("shadowbox:pending-query:session-1", "hi");
    let resolveAppend: (() => void) | undefined;
    const append = vi.fn<[{ role: "user"; content: string }], Promise<void>>(
      () =>
        new Promise((resolve) => {
          resolveAppend = resolve;
        }),
    );

    const { rerender } = renderHook(
      ({ sessionId, runId }) =>
        useChatPersistence({
          sessionId,
          runId,
          messages: [],
          messagesLength: 0,
          isLoading: false,
          isModelConfigReady: true,
          allowPendingQueryRestore: true,
          append,
        }),
      { initialProps: { sessionId: "session-1", runId: "run-1" } },
    );

    await waitFor(() => {
      expect(append).toHaveBeenCalledTimes(1);
    });
    expect(localStorage.getItem("shadowbox:pending-query:session-1")).toBeNull();

    rerender({ sessionId: "session-2", runId: "run-2" });
    resolveAppend?.();
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    rerender({ sessionId: "session-1", runId: "run-1" });
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(append).toHaveBeenCalledTimes(1);
  });

  it("clears stale pending queries when hydrated messages already exist", async () => {
    localStorage.setItem("shadowbox:pending-query:session-1", "hi");
    const append = vi.fn<[{ role: "user"; content: string }], Promise<void>>(
      async () => undefined,
    );
    const messages = [
      {
        id: "message-1",
        role: "assistant",
        content: "already hydrated",
      },
    ] satisfies Message[];

    renderHook(() =>
      useChatPersistence({
        sessionId: "session-1",
        runId: "run-1",
        messages,
        messagesLength: messages.length,
        isLoading: false,
        isModelConfigReady: true,
        allowPendingQueryRestore: true,
        append,
      }),
    );

    await waitFor(() => {
      expect(localStorage.getItem("shadowbox:pending-query:session-1")).toBeNull();
    });
    expect(append).not.toHaveBeenCalled();
  });

  it("drops pending queries for non-running sessions", async () => {
    localStorage.setItem("shadowbox:pending-query:session-1", "old prompt");
    const append = vi.fn<[{ role: "user"; content: string }], Promise<void>>(
      async () => undefined,
    );

    renderHook(() =>
      useChatPersistence({
        sessionId: "session-1",
        runId: "run-1",
        messages: [],
        messagesLength: 0,
        isLoading: false,
        isModelConfigReady: true,
        allowPendingQueryRestore: false,
        append,
      }),
    );

    await waitFor(() => {
      expect(localStorage.getItem("shadowbox:pending-query:session-1")).toBeNull();
    });
    expect(append).not.toHaveBeenCalled();
  });
});
