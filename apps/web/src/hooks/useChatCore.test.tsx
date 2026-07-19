import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentStore } from "../store/agentStore";
import { useChatCore } from "./useChatCore";
import {
  conversationScopeKey,
  createConversationScope,
} from "./conversationScope";

const testScope = createConversationScope({
  workspaceId: "123e4567-e89b-42d3-a456-426614174000",
  threadId: "thr_test-1",
  turnId: "trn_test-1",
  runAttemptId: "attempt_test-1",
  sessionId: "session-1",
  runId: "run-2",
});

const { mockUseChat, mockResolveForChat, mockBootstrapScope } = vi.hoisted(
  () => ({
    mockUseChat: vi.fn(),
    mockResolveForChat: vi.fn(),
    mockBootstrapScope: vi.fn(),
  }),
);

vi.mock("@ai-sdk/react", () => ({
  useChat: mockUseChat,
}));

vi.mock("./useProviderStore.js", () => ({
  useProviderStore: () => ({
    status: "ready",
    credentials: [{ credentialId: "cred-axis", providerId: "axis" }],
    selectedProviderId: "axis",
    selectedCredentialId: "cred-axis",
    selectedModelId: "z-ai/glm-4.5-air:free",
    lastResolvedConfig: {
      providerId: "axis",
      credentialId: "cred-axis",
      modelId: "z-ai/glm-4.5-air:free",
      resolvedAt: "workspace_preference",
      resolvedAtTime: new Date().toISOString(),
    },
    resolveForChat: mockResolveForChat,
  }),
}));

vi.mock("./conversationScope", async () => {
  const actual = await vi.importActual<typeof import("./conversationScope")>(
    "./conversationScope",
  );
  return { ...actual, bootstrapConversationScope: mockBootstrapScope };
});

vi.mock("../lib/platform-endpoints.js", () => ({
  chatStreamPath: () => "https://brain.local/chat",
  getBrainHttpBase: () => "https://brain.local",
}));

vi.mock("../lib/run-summary-events.js", () => ({
  dispatchRunSummaryRefresh: vi.fn(),
}));

vi.mock("../services/SessionStateService", () => ({
  SessionStateService: {
    loadSessionGitHubContext: vi.fn(() => null),
  },
}));

describe("useChatCore", () => {
  let appendSpy: ReturnType<typeof vi.fn>;
  let stopStreamSpy: ReturnType<typeof vi.fn>;
  let setMessagesSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockResolveForChat.mockReset();
    mockBootstrapScope.mockReset();
    mockBootstrapScope.mockImplementation(
      async (sessionId: string, runId: string, clientMessageId?: string) =>
        createConversationScope({
          ...testScope,
          ...(clientMessageId
            ? {
                turnId: `trn_${clientMessageId}`,
                runAttemptId: `attempt_${clientMessageId}`,
              }
            : {}),
          sessionId,
          runId,
        }),
    );
    mockUseChat.mockReset();
    appendSpy = vi.fn();
    stopStreamSpy = vi.fn();
    setMessagesSpy = vi.fn();
    mockUseChat.mockReturnValue({
      messages: [],
      input: "",
      handleInputChange: vi.fn(),
      isLoading: false,
      stop: stopStreamSpy,
      setMessages: setMessagesSpy,
      append: appendSpy,
    });
    localStorage.clear();
    agentStore.clearAllMessages();
  });

  it("configures chat requests with cookie credentials", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    renderHook(() => useChatCore("session-1"));

    const options = mockUseChat.mock.calls[0]?.[0] as {
      credentials?: RequestCredentials;
      fetch?: (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => Promise<Response>;
    };

    expect(options.credentials).toBe("include");
    expect(options.fetch).toBeDefined();

    await options.fetch?.("https://brain.local/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
    });

    expect(fetchSpy).toHaveBeenCalledWith("https://brain.local/chat", {
      method: "POST",
      credentials: "include",
      headers: expect.any(Headers),
    });

    const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.has("Authorization")).toBe(false);
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("surfaces expired session auth as a clear login message", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { result } = renderHook(() => useChatCore("session-1"));

    const options = mockUseChat.mock.calls[0]?.[0] as {
      onError?: (error: Error) => void;
    };

    act(() => {
      options.onError?.(
        new Error(
          JSON.stringify({
            error: "Unauthorized: missing authentication token.",
            code: "AUTH_FAILED",
          }),
        ),
      );
    });

    expect(result.current.error).toBe(
      "Your session is missing or expired. Log in again and retry.",
    );
    expect(consoleError).toHaveBeenCalledWith(
      "🧬 [LegionCode] Chat Stream Error:",
      "Your session is missing or expired. Log in again and retry.",
    );
  });

  it("ignores stale stream callbacks after switching session scope", async () => {
    mockBootstrapScope.mockImplementation((sessionId: string, runId: string) =>
      Promise.resolve(
        createConversationScope({
          workspaceId: "123e4567-e89b-42d3-a456-426614174000",
          threadId: `thr_${sessionId.replace(/[^A-Za-z0-9]/g, "")}001`,
          turnId: `trn_${runId.replace(/[^A-Za-z0-9]/g, "")}001`,
          runAttemptId: `attempt_${runId.replace(/[^A-Za-z0-9]/g, "")}001`,
          sessionId,
          runId,
        }),
      ),
    );
    const { result, rerender } = renderHook(
      ({ sessionId, runId }) => useChatCore(sessionId, runId),
      {
        initialProps: {
          sessionId: "session-1",
          runId: "run-1",
        },
      },
    );

    await waitFor(() =>
      expect(result.current.scope?.threadId).toBe("thr_session1001"),
    );
    const firstScopeKey = conversationScopeKey(result.current.scope!);

    const firstOptions = mockUseChat.mock.calls[0]?.[0] as {
      onError?: (error: Error) => void;
      onFinish?: (message: { content: string }, details: unknown) => void;
      onResponse?: (response: Response) => void;
    };

    act(() => {
      rerender({ sessionId: "session-2", runId: "run-2" });
    });

    await waitFor(() => expect(result.current.scope).not.toBeNull());
    expect(conversationScopeKey(result.current.scope!)).not.toBe(firstScopeKey);

    act(() => {
      firstOptions.onError?.(new Error("old stream failed"));
      firstOptions.onResponse?.(new Response(null, { status: 500 }));
      firstOptions.onFinish?.({ content: "old assistant reply" }, {});
    });

    expect(result.current.error).toBeNull();
    expect(result.current.debugEvents).toHaveLength(0);
  });

  it("uses the pre-stream bootstrap turnId as the canonical turn identity", async () => {
    const { result } = renderHook(() => useChatCore("session-1"));

    await waitFor(() => expect(result.current.scope).not.toBeNull());
    expect(result.current.serverTurnId).toBe("trn_test-1");

    const options = mockUseChat.mock.calls[0]?.[0] as {
      onResponse?: (response: Response) => void;
    };

    act(() => {
      options.onResponse?.(
        new Response(null, {
          status: 200,
          headers: { "X-Turn-Id": "trn_test-1" },
        }),
      );
    });

    expect(result.current.serverTurnId).toBe("trn_test-1");
  });

  it("does not swap the canonical turnId from a post-stream header", async () => {
    const { result } = renderHook(() => useChatCore("session-1"));

    await waitFor(() => expect(result.current.scope).not.toBeNull());

    const options = mockUseChat.mock.calls[0]?.[0] as {
      onResponse?: (response: Response) => void;
    };

    act(() => {
      options.onResponse?.(
        new Response(null, {
          status: 200,
          headers: { "X-Turn-Id": "trn_mismatched001" },
        }),
      );
    });
    act(() => {
      options.onResponse?.(new Response(null, { status: 200 }));
    });

    expect(result.current.serverTurnId).toBe("trn_test-1");
  });

  it("does not hydrate transcript state from the global cache on scope changes", () => {
    const { rerender } = renderHook(
      ({ sessionId, runId }) => useChatCore(sessionId, runId),
      {
        initialProps: {
          sessionId: "session-1",
          runId: "run-1",
        },
      },
    );

    setMessagesSpy.mockClear();

    act(() => {
      rerender({ sessionId: "session-1", runId: "run-2" });
    });

    expect(setMessagesSpy).not.toHaveBeenCalled();
  });

  it("leaves transcript ownership with the remounted Vercel chat instance", async () => {
    const staleMessages = [
      {
        id: "old-message",
        role: "assistant" as const,
        content: "wrong chat",
      },
    ];
    const currentMessages = [
      {
        id: "current-message",
        role: "assistant" as const,
        content: "current chat",
      },
    ];
    mockUseChat.mockReturnValue({
      messages: staleMessages,
      input: "",
      handleInputChange: vi.fn(),
      isLoading: false,
      stop: stopStreamSpy,
      setMessages: setMessagesSpy,
      append: appendSpy,
    });
    agentStore.setMessages(testScope, currentMessages);

    const { result, rerender } = renderHook(
      ({ sessionId, runId }) => useChatCore(sessionId, runId),
      {
        initialProps: {
          sessionId: "session-1",
          runId: "run-1",
        },
      },
    );

    await waitFor(() => expect(result.current.scope).not.toBeNull());

    act(() => {
      rerender({ sessionId: "session-2", runId: "run-2" });
    });

    await waitFor(() => expect(result.current.scope).not.toBeNull());

    expect(result.current.messages).toEqual(staleMessages);
    expect(agentStore.getMessages(testScope)).toEqual(currentMessages);
  });

  it("sends explicit plan mode in request overrides", async () => {
    const { result } = renderHook(() =>
      useChatCore("session-1", undefined, "plan"),
    );

    await waitFor(() => expect(result.current.scope).not.toBeNull());

    await act(async () => {
      await result.current.append({
        role: "user",
        content: "Design this first",
      });
    });

    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^client_msg_/),
        role: "user",
        content: "Design this first",
      }),
      expect.objectContaining({
        body: expect.objectContaining({
          sessionId: "session-1",
          runId: expect.stringMatching(/^run_/),
          clientMessageId: expect.stringMatching(/^client_msg_/),
          mode: "plan",
          identity: {
            workspaceId: testScope.workspaceId,
            threadId: testScope.threadId,
            turnId: expect.stringMatching(/^trn_client_msg_/),
            runAttemptId: expect.stringMatching(/^attempt_client_msg_/),
          },
        }),
      }),
    );
  });

  it("includes selected product mode in request overrides", async () => {
    const { result } = renderHook(() =>
      useChatCore("session-1", undefined, "build", "full_agent"),
    );

    await waitFor(() => expect(result.current.scope).not.toBeNull());

    await act(async () => {
      await result.current.append({
        role: "user",
        content: "Run this end-to-end",
      });
    });

    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^client_msg_/),
        role: "user",
        content: "Run this end-to-end",
      }),
      expect.objectContaining({
        body: expect.objectContaining({
          sessionId: "session-1",
          clientMessageId: expect.stringMatching(/^client_msg_/),
          mode: "build",
          productMode: "full_agent",
        }),
      }),
    );
  });

  it("skips provider resolve API call when selection already exists", async () => {
    const { result } = renderHook(() => useChatCore("session-1"));

    await waitFor(() => expect(result.current.scope).not.toBeNull());

    await act(async () => {
      await result.current.append({
        role: "user",
        content: "Fast path submit",
      });
    });

    expect(mockResolveForChat).not.toHaveBeenCalled();
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^client_msg_/),
        role: "user",
        content: "Fast path submit",
      }),
      expect.objectContaining({
        body: expect.objectContaining({
          clientMessageId: expect.stringMatching(/^client_msg_/),
          providerId: "axis",
          modelId: "z-ai/glm-4.5-air:free",
        }),
      }),
    );
  });

  it("returns false when submit is blocked before append", async () => {
    const { result } = renderHook(() => useChatCore("session-1"));
    let submitted = true;

    await act(async () => {
      submitted = await result.current.handleSubmit();
    });

    expect(submitted).toBe(false);
    expect(appendSpy).not.toHaveBeenCalled();
  });

  it("returns true when submit appends the prepared message", async () => {
    mockUseChat.mockReturnValue({
      messages: [],
      input: "Review the diff",
      handleInputChange: vi.fn(),
      isLoading: false,
      stop: stopStreamSpy,
      setMessages: setMessagesSpy,
      append: appendSpy,
    });
    const { result } = renderHook(() => useChatCore("session-1"));
    await waitFor(() => expect(result.current.scope).not.toBeNull());
    let submitted = false;

    await act(async () => {
      submitted = await result.current.handleSubmit();
    });

    expect(submitted).toBe(true);
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^client_msg_/),
        role: "user",
        content: "Review the diff",
      }),
      expect.objectContaining({
        body: expect.objectContaining({
          sessionId: "session-1",
          clientMessageId: expect.stringMatching(/^client_msg_/),
        }),
      }),
    );
  });

  it("submits image-only messages with redacted debug metadata", async () => {
    const { result } = renderHook(() => useChatCore("session-1"));
    await waitFor(() => expect(result.current.scope).not.toBeNull());
    let submitted = false;

    await act(async () => {
      submitted = await result.current.handleSubmit(undefined, {
        imageAttachments: [
          {
            id: "image-1",
            name: "screen.png",
            mediaType: "image/png",
            dataUrl: "data:image/png;base64,aGVsbG8=",
            previewUrl: "blob:preview",
            byteSize: 5,
            source: "paste",
          },
        ],
      });
    });

    expect(submitted).toBe(true);
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^client_msg_/),
        role: "user",
        content: [
          { type: "text", text: "Analyze the attached image(s)." },
          {
            type: "image",
            image: "data:image/png;base64,aGVsbG8=",
            mimeType: "image/png",
            name: "screen.png",
          },
        ],
        imageMetadata: [
          {
            id: "image-1",
            name: "screen.png",
            mediaType: "image/png",
            byteSize: 5,
            source: "paste",
          },
        ],
      }),
      expect.objectContaining({
        body: expect.objectContaining({
          sessionId: "session-1",
          clientMessageId: expect.stringMatching(/^client_msg_/),
        }),
      }),
    );
  });

  it("uses one client message id for pending echo and append request", async () => {
    let resolveAppend: (() => void) | null = null;
    appendSpy.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveAppend = resolve;
        }),
    );
    const { result } = renderHook(() => useChatCore("session-1"));

    await waitFor(() => expect(result.current.scope).not.toBeNull());

    act(() => {
      void result.current.append({
        role: "user",
        content: "Keep this prompt singular",
      });
    });

    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    const pendingMessage = result.current.messages[0];
    expect(pendingMessage).toMatchObject({
      id: expect.stringMatching(/^client_msg_/),
      role: "user",
      content: "Keep this prompt singular",
    });

    await waitFor(() => expect(appendSpy).toHaveBeenCalledTimes(1));
    const [appendedMessage, options] = appendSpy.mock.calls[0] as [
      { id?: string },
      { body: { clientMessageId?: string } },
    ];
    expect(appendedMessage.id).toBe(pendingMessage?.id);
    expect(options.body.clientMessageId).toBe(pendingMessage?.id);
    expect(options.body).toMatchObject({
      identity: {
        turnId: `trn_${pendingMessage?.id}`,
        runAttemptId: `attempt_${pendingMessage?.id}`,
      },
    });
    expect(mockBootstrapScope).toHaveBeenLastCalledWith(
      "session-1",
      result.current.scope?.runId,
      pendingMessage?.id,
    );

    await act(async () => {
      resolveAppend?.();
      await Promise.resolve();
    });
  });

  it("does not append the pending echo after the stream has projected the same prompt", async () => {
    let resolveAppend: (() => void) | null = null;
    let streamMessages: Array<{
      id: string;
      role: "user" | "assistant";
      content: string;
    }> = [];
    appendSpy.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveAppend = resolve;
        }),
    );
    mockUseChat.mockImplementation(() => ({
      messages: streamMessages,
      input: "",
      handleInputChange: vi.fn(),
      isLoading: true,
      stop: stopStreamSpy,
      setMessages: setMessagesSpy,
      append: appendSpy,
    }));
    const { result, rerender } = renderHook(() =>
      useChatCore("session-1"),
    );

    await waitFor(() => expect(result.current.scope).not.toBeNull());
    act(() => {
      void result.current.append({
        role: "user",
        content: "Keep this prompt singular",
      });
    });
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    const pendingId = result.current.messages[0]?.id;
    expect(pendingId).toMatch(/^client_msg_/);

    streamMessages = [
      {
        id: pendingId!,
        role: "user",
        content: "Keep this prompt singular",
      },
      {
        id: "assistant-failure",
        role: "assistant",
        content: "The request failed.",
      },
    ];
    rerender();

    expect(result.current.messages).toEqual(streamMessages);
    expect(
      result.current.messages.filter((message) => message.id === pendingId),
    ).toHaveLength(1);

    await act(async () => {
      resolveAppend?.();
      await Promise.resolve();
    });
  });

  it("marks chat loading immediately while append setup is in flight", async () => {
    let resolveAppend: (() => void) | null = null;
    appendSpy.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveAppend = resolve;
        }),
    );
    const { result } = renderHook(() => useChatCore("session-1"));

    await waitFor(() => expect(result.current.scope).not.toBeNull());

    act(() => {
      void result.current.append({
        role: "user",
        content: "Start the next task",
      });
    });

    expect(result.current.isLoading).toBe(true);
    expect(result.current.messages).toEqual([
      expect.objectContaining({
        role: "user",
        content: "Start the next task",
      }),
    ]);

    await waitFor(() => expect(appendSpy).toHaveBeenCalledTimes(1));
    await act(async () => {
      resolveAppend?.();
      await Promise.resolve();
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.messages).toEqual([]);
  });

  it("shows a repeated pending prompt after an assistant response", async () => {
    let resolveAppend: (() => void) | null = null;
    appendSpy.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveAppend = resolve;
        }),
    );
    agentStore.setMessages(
      createConversationScope({
        workspaceId: "123e4567-e89b-42d3-a456-426614174000",
        threadId: "thr_session-1",
        turnId: "trn_repeatedprompt001",
        runAttemptId: "attempt_repeatedprompt001",
        sessionId: "session-1",
        runId: "run-repeated-prompt",
      }),
      [
        { id: "user-1", role: "user", content: "try again" },
        { id: "assistant-1", role: "assistant", content: "First answer" },
      ],
    );
    mockUseChat.mockReturnValue({
      messages: agentStore.getMessages(
        createConversationScope({
          workspaceId: "123e4567-e89b-42d3-a456-426614174000",
          threadId: "thr_session-1",
          turnId: "trn_repeatedprompt001",
          runAttemptId: "attempt_repeatedprompt001",
          sessionId: "session-1",
          runId: "run-repeated-prompt",
        }),
      ),
      input: "",
      handleInputChange: vi.fn(),
      isLoading: false,
      stop: stopStreamSpy,
      setMessages: setMessagesSpy,
      append: appendSpy,
    });
    const { result } = renderHook(() =>
      useChatCore("session-1", "run-repeated-prompt"),
    );

    await waitFor(() => expect(result.current.scope).not.toBeNull());

    act(() => {
      void result.current.append({
        role: "user",
        content: "try again",
      });
    });

    expect(result.current.messages).toEqual([
      expect.objectContaining({ id: "user-1", role: "user" }),
      expect.objectContaining({ id: "assistant-1", role: "assistant" }),
      expect.objectContaining({
        id: expect.stringMatching(/^client_msg_/),
        role: "user",
        content: "try again",
      }),
    ]);

    await act(async () => {
      resolveAppend?.();
      await Promise.resolve();
    });
  });

  it("keeps stop active until the cancel request settles", async () => {
    let resolveFetch: ((value: Response) => void) | null = null;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const { result } = renderHook(() => useChatCore("session-1"));

    act(() => {
      result.current.stop();
    });

    expect(stopStreamSpy).toHaveBeenCalledTimes(1);
    expect(result.current.isLoading).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://brain.local/api/run/cancel",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
      }),
    );

    await act(async () => {
      resolveFetch?.(new Response("{}", { status: 200 }));
      await Promise.resolve();
    });

    expect(result.current.isLoading).toBe(false);
  });
});
