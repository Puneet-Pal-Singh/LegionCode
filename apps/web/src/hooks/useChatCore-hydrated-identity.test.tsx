import { act, renderHook, waitFor } from "@testing-library/react";
import type { Message } from "@ai-sdk/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildConversationTurns } from "../components/chat/messageMetadata";
import { useChatPresentation } from "../components/chat/chat-interface/useChatPresentation";
import { useChat } from "./useChat";

vi.mock("./useProviderStore.js", () => ({
  useProviderStore: () => ({
    status: "ready",
    credentials: [{ id: "credential_fixture" }],
    selectedProviderId: "openai",
    selectedCredentialId: "credential_fixture",
    selectedModelId: "gpt-fixture",
    lastResolvedConfig: null,
    providerModels: {},
    manageProviderModels: {},
    resolveForChat: vi.fn(),
  }),
}));

vi.mock("./useChatPersistence.js", () => ({
  useChatPersistence: () => undefined,
}));

vi.mock("./useTurnLifecycleProjection.js", () => ({
  useTurnLifecycleProjection: () => ({ projection: null, error: null }),
}));

describe("hydrated transcript identity in the product presentation path", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps an unidentified historical reply out of a later active turn", async () => {
    const historicalScope = {
      workspaceId: "d1137b54-39df-4f38-b012-478018630ace",
      threadId: "thr_history_identity01",
      turnId: "trn_history_identity01",
      runAttemptId: "attempt_history_identity01",
    };
    const currentScope = {
      workspaceId: "d1137b54-39df-4f38-b012-478018630ace",
      threadId: "thr_history_identity01",
      turnId: "trn_current_identity01",
      runAttemptId: "attempt_current_identity01",
    };
    const historyReads: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/turn/scope")) {
          return Response.json(currentScope);
        }
        if (url.pathname.endsWith("/api/chat/history")) {
          historyReads.push(url.searchParams.get("session") ?? "");
          return Response.json({
            messages: [
              {
                id: "historical-user-a",
                role: "user",
                content: "Prompt from turn A",
                createdAt: "2026-10-03T00:00:00.000Z",
                data: {
                  metadata: { canonicalIdentity: historicalScope },
                },
              },
              {
                id: "historical-assistant-a",
                role: "assistant",
                content: "Reply A with unknown identity",
                createdAt: "2026-10-03T00:00:01.000Z",
              },
            ],
            nextCursor: null,
            snapshot: "2",
          });
        }
        throw new Error(`Unexpected request: ${url.toString()}`);
      }),
    );

    const { result } = renderHook(() => {
      const chat = useChat(
        "d1137b54-39df-4f38-b012-478018630ace",
        "run_history_identity01",
      );
      const conversationTurns = buildConversationTurns(chat.messages);
      const presentation = useChatPresentation({
        messages: chat.messages,
        conversationTurns,
        hasHydrated: chat.hasHydrated,
        isLoading: chat.isLoading,
        hasPendingApproval: false,
        hasStartedSession: true,
      });
      return { chat, conversationTurns, presentation };
    });

    await act(async () => {
      await waitFor(() => expect(result.current.chat.hydrationStatus).toBe("readable"));
    });
    await waitFor(() =>
      expect(result.current.chat.scope?.turnId).toBe(currentScope.turnId),
    );

    const historicalReply = result.current.chat.messages.find(
      (message) => message.id === "historical-assistant-a",
    ) as (Message & { data?: { metadata?: Record<string, unknown> } }) | undefined;
    const historicalTurn = result.current.conversationTurns.find(
      (turn) => turn.userMessage?.id === "historical-user-a",
    );
    const visibleReply = result.current.presentation.chatEntries.find(
      (entry) => entry.kind === "message" && entry.message.id === "historical-assistant-a",
    );

    expect(historyReads).toEqual(["d1137b54-39df-4f38-b012-478018630ace"]);
    expect.soft(historicalReply?.data?.metadata?.canonicalIdentity).toBeUndefined();
    expect.soft(historicalReply?.data?.metadata?.phase).toBeUndefined();
    expect.soft(historicalTurn?.turnId).toBe(historicalScope.turnId);
    expect.soft(visibleReply).toMatchObject({
      kind: "message",
      message: {
        id: "historical-assistant-a",
        content: "Reply A with unknown identity",
      },
    });
  });
});
