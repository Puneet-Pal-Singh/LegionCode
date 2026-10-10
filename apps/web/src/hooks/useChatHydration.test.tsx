import { act, renderHook, waitFor } from "@testing-library/react";
import type { Message } from "@ai-sdk/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChatHydration } from "./useChatHydration";

vi.mock("../lib/platform-endpoints", () => ({ getBrainHttpBase: () => "https://brain.local" }));

function response(
  messages: unknown[],
  snapshot = "1",
  nextCursor: string | null = null,
) {
  const timestamp = "2026-10-03T00:00:00.000Z";
  return new Response(
    JSON.stringify({ protocolVersion: "1.0.0", method: "session/history", ok: true, result: {
      messages: messages.map((message) => ({
        createdAt: timestamp,
        ...(message as object),
      })),
      nextCursor,
      snapshot,
    } }),
  );
}

describe("useChatHydration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hydrates by durable session when execution scope is unavailable", async () => {
    const setMessages = vi.fn<[Message[]], void>();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response([
        { id: "saved-user", role: "user", content: "Read README" },
        { id: "saved-assistant", role: "assistant", content: "Project guide" },
      ]),
    );
    const { result } = renderHook(() =>
      useChatHydration("550e8400-e29b-41d4-a716-446655440001", [], setMessages),
    );
    await waitFor(() => expect(result.current.status).toBe("readable"));
    expect(result.current.hasHydrated).toBe(true);
    const envelope = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(envelope.params.session).toBe("550e8400-e29b-41d4-a716-446655440001");
    expect(envelope.params).not.toHaveProperty("runId");
  });

  it("does not leave the presentation loading after an unrecoverable read failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      historyFailure(404),
    );
    const { result } = renderHook(() =>
      useChatHydration("550e8400-e29b-41d4-a716-446655440002", [], vi.fn()),
    );
    await waitFor(() =>
      expect(result.current.status).toBe("recovery-required"),
    );
    expect(result.current.isHydrating).toBe(false);
    expect(result.current.hasHydrated).toBe(true);
  });

  it("waits to read history until a newly-created session is persisted", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        response([
          {
            id: "persisted-first-message",
            role: "user",
            content: "Read README",
          },
        ]),
      );
    const setMessages = vi.fn<[Message[]], void>();
    const { rerender, result } = renderHook(
      ({ enabled }) =>
        useChatHydration("550e8400-e29b-41d4-a716-446655440003", [], setMessages, null, enabled),
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
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((_input, init) => {
        const envelope = JSON.parse(init?.body as string);
        if (envelope.params.session === "550e8400-e29b-41d4-a716-446655440004") {
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve(
          response([{ id: "new", role: "assistant", content: "Current" }]),
        );
      });
    const setMessages = vi.fn<[Message[]], void>();
    const { rerender } = renderHook(
      ({ sessionId }) => useChatHydration(sessionId, [], setMessages),
      {
        initialProps: { sessionId: "550e8400-e29b-41d4-a716-446655440004" },
      },
    );
    await waitFor(() => expect(resolveFirst).toBeDefined());
    rerender({ sessionId: "550e8400-e29b-41d4-a716-446655440005" });
    await waitFor(() => expect(setMessages).toHaveBeenCalledTimes(1));
    await act(async () => {
      resolveFirst(
        response([{ id: "old", role: "assistant", content: "Stale" }]),
      );
    });
    expect(setMessages.mock.calls[0]![0].map(({ id }) => id)).toEqual(["new"]);
    const oldRequest = fetchSpy.mock.calls.find(
      (call) =>
        JSON.parse(call[1]?.body as string).params.session ===
        "550e8400-e29b-41d4-a716-446655440004",
    );
    expect(oldRequest?.[1]?.signal?.aborted).toBe(true);
  });

  it("preserves two equal-text prompts with distinct canonical IDs", async () => {
    const setMessages = vi.fn<[Message[]], void>();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response([
        { id: "user-1", role: "user", content: "repeat" },
        { id: "user-2", role: "user", content: "repeat" },
      ]),
    );
    const live: Message[] = [];
    renderHook(() => useChatHydration("550e8400-e29b-41d4-a716-446655440001", live, setMessages));
    await waitFor(() => expect(setMessages).toHaveBeenCalled());
    expect(setMessages.mock.calls[0]![0].map(({ id }) => id)).toEqual([
      "user-1",
      "user-2",
    ]);
  });

  it("replaces the verified transcript from a complete revision snapshot", async () => {
    let resolveHistory!: (value: Response) => void;
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      new Promise((resolve) => {
        resolveHistory = resolve;
      }),
    );
    const setMessages = vi.fn<[Message[]], void>();
    const initial: Message[] = [
      { id: "superseded-user", role: "user", content: "old prompt" },
      { id: "superseded-answer", role: "assistant", content: "old answer" },
    ];
    renderHook(
      ({ messages }) =>
        useChatHydration("550e8400-e29b-41d4-a716-446655440001", messages, setMessages, "revision-2"),
      { initialProps: { messages: initial } },
    );
    await act(async () => {
      resolveHistory(
        response([
          { id: "canonical-user", role: "user", content: "new prompt" },
          { id: "canonical-answer", role: "assistant", content: "new answer" },
        ]),
      );
    });
    await waitFor(() => expect(setMessages).toHaveBeenCalled());
    expect(setMessages.mock.calls[0]![0].map(({ id }) => id)).toEqual([
      "canonical-user",
      "canonical-answer",
    ]);
  });

  it("uses the durable full text over an unchanged same-ID verified row", async () => {
    const setMessages = vi.fn<[Message[]], void>();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response([
        {
          id: "assistant-1",
          role: "assistant",
          content: "The complete durable answer.",
        },
      ]),
    );
    const stale: Message[] = [
      { id: "assistant-1", role: "assistant", content: "The complete" },
    ];
    renderHook(() => useChatHydration("550e8400-e29b-41d4-a716-446655440001", stale, setMessages));
    await waitFor(() => expect(setMessages).toHaveBeenCalled());
    expect(setMessages.mock.calls[0]![0][0]?.content).toBe(
      "The complete durable answer.",
    );
  });

  it("merges verified partial rows without dropping rows beyond the fetched prefix", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        response(
          [
            {
              id: "assistant-verified",
              role: "assistant",
              content: "updated verified text",
            },
            { id: "prefix-user", role: "user", content: "verified prefix" },
          ],
          "2",
          "1",
        ),
      )
      .mockResolvedValueOnce(
        historyFailure(503),
      );
    const setMessages = vi.fn<[Message[]], void>();
    const initialMessages: Message[] = [
      { id: "assistant-verified", role: "assistant", content: "partial" },
      {
        id: "later-user",
        role: "user",
        content: "already verified beyond this prefix",
      },
    ];
    const { result } = renderHook(
      ({ messages }) => useChatHydration("550e8400-e29b-41d4-a716-446655440001", messages, setMessages),
      { initialProps: { messages: initialMessages } },
    );
    await waitFor(() => expect(result.current.status).toBe("partial"));
    expect(setMessages.mock.calls[0]![0].map(({ id }) => id)).toEqual([
      "assistant-verified",
      "prefix-user",
      "later-user",
    ]);
    expect(setMessages.mock.calls[0]![0][0]?.content).toBe(
      "updated verified text",
    );
  });
});

function historyFailure(status: number) {
  return new Response(JSON.stringify({ protocolVersion: "1.0.0", method: "session/history", ok: false, error: { code: status === 404 ? "not_found" : "server_unavailable", message: "History unavailable" } }), { status });
}
