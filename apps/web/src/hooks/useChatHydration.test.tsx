import { act, renderHook, waitFor } from "@testing-library/react";
import type { Message } from "@ai-sdk/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChatHydration } from "./useChatHydration";

vi.mock("../lib/platform-endpoints.js", () => ({
  chatHistoryPath: (sessionId: string) => `https://brain.local/api/chat/history?session=${sessionId}`,
}));

function response(messages: unknown[], snapshot = "1") {
  const timestamp = "2026-10-03T00:00:00.000Z";
  return new Response(JSON.stringify({
    messages: messages.map((message) => ({ createdAt: timestamp, ...(message as object) })),
    nextCursor: null,
    snapshot,
  }));
}

describe("useChatHydration", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("hydrates by durable session when execution scope is unavailable", async () => {
    const setMessages = vi.fn<[Message[]], void>();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(response([
      { id: "saved-user", role: "user", content: "Read README" },
      { id: "saved-assistant", role: "assistant", content: "Project guide" },
    ]));
    const { result } = renderHook(() => useChatHydration("session-1", [], setMessages));
    await waitFor(() => expect(result.current.status).toBe("readable"));
    expect(result.current.hasHydrated).toBe(true);
    const url = new URL(fetchSpy.mock.calls[0]![0] as string);
    expect(url.searchParams.get("session")).toBe("session-1");
    expect(url.searchParams.has("runId")).toBe(false);
  });

  it("does not leave the presentation loading after an unrecoverable read failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("missing", { status: 404 }));
    const { result } = renderHook(() => useChatHydration("session-missing", [], vi.fn()));
    await waitFor(() => expect(result.current.status).toBe("recovery-required"));
    expect(result.current.isHydrating).toBe(false);
    expect(result.current.hasHydrated).toBe(true);
  });

  it("waits to read history until a newly-created session is persisted", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response([{ id: "persisted-first-message", role: "user", content: "Read README" }]),
    );
    const setMessages = vi.fn<[Message[]], void>();
    const { rerender, result } = renderHook(
      ({ enabled }) => useChatHydration("session-being-saved", [], setMessages, null, enabled),
      { initialProps: { enabled: false } },
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.current.status).toBe("idle");
    rerender({ enabled: true });

    await waitFor(() => expect(result.current.status).toBe("readable"));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(setMessages.mock.calls[0]![0].map(({ id }) => id)).toEqual([
      "persisted-first-message",
    ]);
  });

  it("aborts the old read and never applies it after switching chats", async () => {
    let resolveFirst!: (value: Response) => void;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = new URL(input as string);
      if (url.searchParams.get("session") === "session-old") {
        return new Promise((resolve) => { resolveFirst = resolve; });
      }
      return Promise.resolve(response([{ id: "new", role: "assistant", content: "Current" }]));
    });
    const setMessages = vi.fn<[Message[]], void>();
    const { rerender } = renderHook(({ sessionId }) => useChatHydration(sessionId, [], setMessages), {
      initialProps: { sessionId: "session-old" },
    });
    await waitFor(() => expect(resolveFirst).toBeDefined());
    rerender({ sessionId: "session-new" });
    await waitFor(() => expect(setMessages).toHaveBeenCalledTimes(1));
    await act(async () => {
      resolveFirst(response([{ id: "old", role: "assistant", content: "Stale" }]));
    });
    expect(setMessages.mock.calls[0]![0].map(({ id }) => id)).toEqual(["new"]);
    const oldRequest = fetchSpy.mock.calls.find((call) =>
      new URL(call[0] as string).searchParams.get("session") === "session-old");
    expect(oldRequest?.[1]?.signal?.aborted).toBe(true);
  });

  it("preserves two equal-text prompts with distinct canonical IDs", async () => {
    const setMessages = vi.fn<[Message[]], void>();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response([
      { id: "user-1", role: "user", content: "repeat" },
      { id: "user-2", role: "user", content: "repeat" },
    ]));
    const live: Message[] = [];
    renderHook(() => useChatHydration("session-1", live, setMessages));
    await waitFor(() => expect(setMessages).toHaveBeenCalled());
    expect(setMessages.mock.calls[0]![0].map(({ id }) => id)).toEqual(["user-1", "user-2"]);
  });

  it("replaces unchanged stale revision messages while keeping a new optimistic prompt", async () => {
    let resolveHistory!: (value: Response) => void;
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      new Promise((resolve) => { resolveHistory = resolve; }),
    );
    const setMessages = vi.fn<[Message[]], void>();
    const initial: Message[] = [
      { id: "superseded-user", role: "user", content: "old prompt" },
      { id: "superseded-answer", role: "assistant", content: "old answer" },
    ];
    const { rerender } = renderHook(
      ({ messages }) => useChatHydration("session-1", messages, setMessages, "revision-2"),
      { initialProps: { messages: initial } },
    );
    rerender({ messages: [...initial, { id: "optimistic", role: "user", content: "new prompt" }] });
    await act(async () => {
      resolveHistory(response([
        { id: "canonical-user", role: "user", content: "new prompt" },
        { id: "canonical-answer", role: "assistant", content: "new answer" },
      ]));
    });
    await waitFor(() => expect(setMessages).toHaveBeenCalled());
    expect(setMessages.mock.calls[0]![0].map(({ id }) => id)).toEqual([
      "canonical-user", "canonical-answer", "optimistic",
    ]);
  });

  it("uses the durable full text over an unchanged same-ID stale live message", async () => {
    const setMessages = vi.fn<[Message[]], void>();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response([
      { id: "assistant-1", role: "assistant", content: "The complete durable answer." },
    ]));
    const stale: Message[] = [
      { id: "assistant-1", role: "assistant", content: "The complete" },
    ];
    renderHook(() => useChatHydration("session-1", stale, setMessages));
    await waitFor(() => expect(setMessages).toHaveBeenCalled());
    expect(setMessages.mock.calls[0]![0][0]?.content).toBe("The complete durable answer.");
  });

  it("keeps a live delta when a snapshot page has the same message ID", async () => {
    let resolveHistory!: (value: Response) => void;
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      new Promise((resolve) => { resolveHistory = resolve; }),
    );
    const setMessages = vi.fn<[Message[]], void>();
    const initialMessages: Message[] = [
      { id: "assistant-live", role: "assistant", content: "partial" },
    ];
    const { rerender } = renderHook(
      ({ messages }) => useChatHydration("session-1", messages, setMessages),
      { initialProps: { messages: initialMessages } },
    );
    const updatedMessages: Message[] = [
      { id: "assistant-live", role: "assistant", content: "partial and newer" },
    ];
    rerender({ messages: updatedMessages });
    await act(async () => {
      resolveHistory(response([
        { id: "assistant-live", role: "assistant", content: "older snapshot" },
      ]));
    });
    await waitFor(() => expect(setMessages).toHaveBeenCalled());
    expect(setMessages.mock.calls[0]![0][0]?.content).toBe("partial and newer");
  });
});
