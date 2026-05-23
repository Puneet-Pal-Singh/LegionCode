import { act, renderHook, waitFor } from "@testing-library/react";
import type { Message } from "@ai-sdk/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChatHydration } from "./useChatHydration";

vi.mock("../lib/platform-endpoints.js", () => ({
  chatHistoryPath: (runId: string) =>
    `https://brain.local/api/chat/history/${runId}`,
}));

describe("useChatHydration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not apply stale history after switching session scope", async () => {
    let resolveRunOneFetch: ((response: Response) => void) | null = null;
    const setMessages = vi.fn<[Message[]], void>();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("run-1")) {
          return new Promise<Response>((resolve) => {
            resolveRunOneFetch = resolve;
          });
        }

        return Promise.resolve(
          createHistoryResponse([
            {
              id: "run-2-message",
              role: "assistant",
              content: "current history",
            },
          ]),
        );
      });

    const { rerender } = renderHook(
      ({ sessionId, runId }) =>
        useChatHydration(sessionId, runId, 0, setMessages),
      {
        initialProps: {
          sessionId: "session-1",
          runId: "run-1",
        },
      },
    );

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("run-1"),
        expect.objectContaining({ credentials: "include" }),
      );
    });

    rerender({ sessionId: "session-2", runId: "run-2" });

    await waitFor(() => {
      expect(setMessages).toHaveBeenCalledWith([
        expect.objectContaining({
          id: "run-2-message",
          content: "current history",
        }),
      ]);
    });

    await act(async () => {
      resolveRunOneFetch?.(
        createHistoryResponse([
          {
            id: "run-1-message",
            role: "assistant",
            content: "stale history",
          },
        ]),
      );
      await Promise.resolve();
    });

    expect(setMessages).not.toHaveBeenCalledWith([
      expect.objectContaining({
        id: "run-1-message",
        content: "stale history",
      }),
    ]);
  });

  it("retries failed hydration before allowing pending query replay", async () => {
    const setMessages = vi.fn<[Message[]], void>();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        createHistoryResponse([
          {
            id: "message-after-retry",
            role: "assistant",
            content: "hydrated on retry",
          },
        ]),
      );

    const { result } = renderHook(() =>
      useChatHydration("session-1", "run-1", 0, setMessages),
    );

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
    expect(result.current.hasHydrated).toBe(false);

    await waitFor(() => {
      expect(setMessages).toHaveBeenCalledWith([
        expect.objectContaining({
          id: "message-after-retry",
          content: "hydrated on retry",
        }),
      ]);
    });
    expect(result.current.hasHydrated).toBe(true);
  });
});

function createHistoryResponse(messages: unknown[]): Response {
  return new Response(JSON.stringify({ messages }), { status: 200 });
}
