import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatCore } from "./useChatCore";

const { mockUseChat, mockResolveForChat } = vi.hoisted(() => ({
  mockUseChat: vi.fn(),
  mockResolveForChat: vi.fn(),
}));

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
  });

  it("ignores stale stream callbacks after switching session scope", () => {
    const { result, rerender } = renderHook(
      ({ sessionId, runId }) => useChatCore(sessionId, runId),
      {
        initialProps: {
          sessionId: "session-1",
          runId: "run-1",
        },
      },
    );

    const firstOptions = mockUseChat.mock.calls[0]?.[0] as {
      onError?: (error: Error) => void;
      onFinish?: (message: { content: string }, details: unknown) => void;
      onResponse?: (response: Response) => void;
    };

    act(() => {
      rerender({ sessionId: "session-2", runId: "run-2" });
    });

    act(() => {
      firstOptions.onError?.(new Error("old stream failed"));
      firstOptions.onResponse?.(new Response(null, { status: 500 }));
      firstOptions.onFinish?.({ content: "old assistant reply" }, {});
    });

    expect(result.current.error).toBeNull();
    expect(result.current.debugEvents).toHaveLength(0);
  });

  it("clears local chat messages when switching run scope", () => {
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

    expect(setMessagesSpy).toHaveBeenCalledWith([]);
  });

  it("sends explicit plan mode in request overrides", async () => {
    const { result } = renderHook(() =>
      useChatCore("session-1", undefined, "plan"),
    );

    await act(async () => {
      await result.current.append({
        role: "user",
        content: "Design this first",
      });
    });

    expect(appendSpy).toHaveBeenCalledWith(
      { role: "user", content: "Design this first" },
      expect.objectContaining({
        body: expect.objectContaining({
          sessionId: "session-1",
          mode: "plan",
        }),
      }),
    );
  });

  it("includes selected product mode in request overrides", async () => {
    const { result } = renderHook(() =>
      useChatCore("session-1", undefined, "build", "full_agent"),
    );

    await act(async () => {
      await result.current.append({
        role: "user",
        content: "Run this end-to-end",
      });
    });

    expect(appendSpy).toHaveBeenCalledWith(
      { role: "user", content: "Run this end-to-end" },
      expect.objectContaining({
        body: expect.objectContaining({
          sessionId: "session-1",
          mode: "build",
          productMode: "full_agent",
        }),
      }),
    );
  });

  it("skips provider resolve API call when selection already exists", async () => {
    const { result } = renderHook(() => useChatCore("session-1"));

    await act(async () => {
      await result.current.append({
        role: "user",
        content: "Fast path submit",
      });
    });

    expect(mockResolveForChat).not.toHaveBeenCalled();
    expect(appendSpy).toHaveBeenCalledWith(
      { role: "user", content: "Fast path submit" },
      expect.objectContaining({
        body: expect.objectContaining({
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
    let submitted = false;

    await act(async () => {
      submitted = await result.current.handleSubmit();
    });

    expect(submitted).toBe(true);
    expect(appendSpy).toHaveBeenCalledWith(
      { role: "user", content: "Review the diff" },
      expect.objectContaining({
        body: expect.objectContaining({
          sessionId: "session-1",
        }),
      }),
    );
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

    act(() => {
      void result.current.append({
        role: "user",
        content: "Start the next task",
      });
    });

    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      resolveAppend?.();
      await Promise.resolve();
    });

    expect(result.current.isLoading).toBe(false);
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
