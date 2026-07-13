import { renderHook, waitFor } from "@testing-library/react";
import type { Message } from "@ai-sdk/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentStore } from "../store/agentStore";
import { useChatPersistence } from "./useChatPersistence";
import { createConversationScope } from "./conversationScope";

const scope = createConversationScope({
  workspaceId: "123e4567-e89b-42d3-a456-426614174000",
  threadId: "thr_test-1",
  turnId: "trn_test-1",
  runAttemptId: "attempt_test-1",
  sessionId: "session-1",
  runId: "run-1",
});

describe("useChatPersistence", () => {
  beforeEach(() => {
    localStorage.clear();
    agentStore.clearAllMessages();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not read browser storage while mirroring messages", async () => {
    const getItemSpy = vi.spyOn(Storage.prototype, "getItem");

    renderHook(() =>
      useChatPersistence({
        scope,
        messages: [],
      }),
    );

    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(getItemSpy).not.toHaveBeenCalled();
  });

  it("syncs empty message arrays to clear stale agent store entries", async () => {
    const oldMessage = {
      id: "old-message",
      role: "assistant",
      content: "stale",
    } satisfies Message;
    agentStore.setMessages(scope, [oldMessage]);

    renderHook(() =>
      useChatPersistence({
        scope,
        messages: [],
      }),
    );

    await waitFor(() => {
      expect(agentStore.getMessages(scope)).toEqual([]);
    });
  });

  it("does not write browser storage when hydrated messages exist", async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    const messages = [
      {
        id: "message-1",
        role: "assistant",
        content: "already hydrated",
      },
    ] satisfies Message[];

    renderHook(() =>
      useChatPersistence({
        scope,
        messages,
      }),
    );

    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(setItemSpy).not.toHaveBeenCalled();
  });
});
