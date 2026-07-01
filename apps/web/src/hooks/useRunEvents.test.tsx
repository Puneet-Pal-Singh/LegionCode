import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RUN_EVENT_TYPES } from "@repo/shared-types";
import { RUN_SUMMARY_REFRESH_EVENT } from "../lib/run-summary-events.js";
import { useRunEvents } from "./useRunEvents.js";

vi.mock("../lib/platform-endpoints.js", () => ({
  runEventsPath: (runId: string) =>
    `https://brain.local/api/run/events?runId=${encodeURIComponent(runId)}`,
  runEventsStreamPath: (runId: string) =>
    `https://brain.local/api/run/events/stream?runId=${encodeURIComponent(runId)}`,
}));

describe("useRunEvents", () => {
  const originalVisibilityState = document.visibilityState;

  beforeEach(() => {
    vi.restoreAllMocks();
    setVisibilityState("visible");
  });

  afterEach(() => {
    setVisibilityState(originalVisibilityState);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("resets fetch state for a new runId and ignores stale responses", async () => {
    const resolveFetches = new Map<string, (response: Response) => void>();
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const runId = new URL(String(input)).searchParams.get("runId") ?? "";
      return new Promise((resolve) => {
        resolveFetches.set(runId, resolve);
      });
    });

    const { result, rerender } = renderHook(
      ({ runId }) => useRunEvents(runId),
      { initialProps: { runId: "run-a" } },
    );

    rerender({ runId: "run-b" });

    resolveFetches.get("run-b")?.(
      createEventsResponse(
        createMessageEvent("run-b", "evt-b", "Current run event"),
      ),
    );
    resolveFetches.get("run-a")?.(
      createEventsResponse(
        createMessageEvent("run-a", "evt-a", "Stale run event"),
      ),
    );

    await waitFor(() => {
      expect(result.current.events).toHaveLength(1);
    });

    expect(result.current.events[0]?.runId).toBe("run-b");
    expect(result.current.events[0]?.eventId).toBe("evt-b");
  });

  it("accepts canonical JSON array event responses from Brain", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      createEventsJsonResponse(
        createMessageEvent("run-json", "evt-json", "JSON event"),
      ),
    );

    const { result } = renderHook(() => useRunEvents("run-json"));

    await waitFor(() => {
      expect(result.current.events).toHaveLength(1);
    });

    expect(result.current.events[0]?.eventId).toBe("evt-json");
  });

  it("drops parsed events that belong to a different runId", async () => {
    vi.stubEnv("MODE", "development");
    const sendBeaconSpy = vi.fn();
    vi.stubGlobal("navigator", {
      ...navigator,
      sendBeacon: sendBeaconSpy,
    });
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      createEventsJsonResponse(
        createMessageEvent("run-other", "evt-other", "Wrong run"),
        createMessageEvent("run-current", "evt-current", "Current run"),
      ),
    );

    const { result } = renderHook(() => useRunEvents("run-current"));

    await waitFor(() => {
      expect(result.current.events).toHaveLength(1);
    });

    expect(result.current.events[0]?.eventId).toBe("evt-current");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[run/events/dropped-mismatched-run]"),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("eventRunId=run-other"),
    );
  });

  it("catches up hidden-tab refreshes when the document becomes visible again", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => createEventsResponse());

    renderHook(() => useRunEvents("run-visible"));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    setVisibilityState("hidden");
    act(() => {
      window.dispatchEvent(
        new CustomEvent(RUN_SUMMARY_REFRESH_EVENT, {
          detail: { runId: "run-visible" },
        }),
      );
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);

    setVisibilityState("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  it("streams canonical runtime events while the run is active", async () => {
    const refreshSpy = vi.spyOn(window, "dispatchEvent");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/stream?")) {
        return createStreamResponse(
          createMessageEvent("run-live", "evt-2", "Tool finished"),
        );
      }

      return createEventsResponse(
        createMessageEvent("run-live", "evt-1", "Started"),
      );
    });

    const { result } = renderHook(() => useRunEvents("run-live", true));

    await waitFor(() => {
      expect(result.current.events).toHaveLength(2);
    });

    expect(result.current.events.map((event) => event.eventId)).toEqual(
      expect.arrayContaining(["evt-1", "evt-2"]),
    );
    expect(refreshSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: RUN_SUMMARY_REFRESH_EVENT,
      }),
    );
  });

  it("reconnects when the stream endpoint is temporarily unavailable", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        const streamCalls = fetchSpy.mock.calls.filter(([callInput]) =>
          String(callInput).includes("/stream?"),
        ).length;
        if (url.includes("/stream?")) {
          return streamCalls === 1
            ? new Response("Not ready", { status: 404 })
            : createStreamResponse(
                createMessageEvent("run-retry", "evt-retry", "Started"),
              );
        }

        return createEventsResponse();
      });

    const { result, unmount } = renderHook(() =>
      useRunEvents("run-retry", true),
    );

    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.filter(([input]) =>
          String(input).includes("/stream?"),
        ),
      ).toHaveLength(2);
    });

    await waitFor(() => {
      expect(
        result.current.events.some((event) => event.eventId === "evt-retry"),
      ).toBe(true);
    });

    unmount();
  });

  it("does not reconnect after a normally closed terminal stream", async () => {
    vi.useFakeTimers();
    try {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input) => {
          const url = String(input);
          return url.includes("/stream?")
            ? createStreamResponse(
                createMessageEvent("run-terminal", "evt-terminal", "Done"),
              )
            : createEventsResponse();
        });

      const { unmount } = renderHook(() => useRunEvents("run-terminal", true));
      await flushMicrotasks();

      act(() => vi.advanceTimersByTime(1_000));
      await flushMicrotasks();

      expect(
        fetchSpy.mock.calls.filter(([input]) =>
          String(input).includes("/stream?"),
        ),
      ).toHaveLength(1);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reopens a completed stream when the same run starts another turn", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        const streamCalls = fetchSpy.mock.calls.filter(([callInput]) =>
          String(callInput).includes("/stream?"),
        ).length;
        if (url.includes("/stream?")) {
          return streamCalls === 1
            ? createStreamResponse(createRunCompletedEvent("run-reused"))
            : createStreamResponse(
                createMessageEvent("run-reused", "evt-second-turn", "Started"),
              );
        }

        return createEventsResponse();
      });

    const { result } = renderHook(() => useRunEvents("run-reused", true));

    await waitFor(() => {
      expect(result.current.events.some(isRunCompletedEvent)).toBe(true);
    });

    act(() => {
      window.dispatchEvent(
        new CustomEvent(RUN_SUMMARY_REFRESH_EVENT, {
          detail: { runId: "run-reused" },
        }),
      );
    });

    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.filter(([input]) =>
          String(input).includes("/stream?"),
        ),
      ).toHaveLength(2);
    });

    await waitFor(() => {
      expect(
        result.current.events.some(
          (event) => event.eventId === "evt-second-turn",
        ),
      ).toBe(true);
    });
  });

  it("retries after Brain reports the run missing before it is created", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("Not Found", { status: 404 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));

    renderHook(() => useRunEvents("missing-run"));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    act(() => {
      window.dispatchEvent(
        new CustomEvent(RUN_SUMMARY_REFRESH_EVENT, {
          detail: { runId: "missing-run" },
        }),
      );
    });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });
});

function createEventsResponse(
  ...events: Array<Record<string, unknown>>
): Response {
  return new Response(events.map((event) => JSON.stringify(event)).join("\n"), {
    status: 200,
  });
}

function createEventsJsonResponse(
  ...events: Array<Record<string, unknown>>
): Response {
  return new Response(JSON.stringify(events), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function createStreamResponse(
  ...events: Array<Record<string, unknown>>
): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        }
        controller.close();
      },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
      },
    },
  );
}

function createMessageEvent(runId: string, eventId: string, content: string) {
  return {
    version: 1,
    eventId,
    runId,
    sessionId: "session-1",
    timestamp: "2026-03-24T00:00:00.000Z",
    source: "brain",
    type: RUN_EVENT_TYPES.MESSAGE_EMITTED,
    payload: {
      content,
      role: "assistant",
    },
  };
}

function createRunCompletedEvent(runId: string) {
  return {
    version: 1,
    eventId: "evt-run-completed",
    runId,
    sessionId: "session-1",
    timestamp: "2026-03-24T00:00:01.000Z",
    source: "brain",
    type: RUN_EVENT_TYPES.RUN_COMPLETED,
    payload: {
      status: "complete",
      totalDurationMs: 1_000,
      toolsUsed: 0,
    },
  };
}

function isRunCompletedEvent(event: { type: string }): boolean {
  return event.type === RUN_EVENT_TYPES.RUN_COMPLETED;
}

function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: state,
  });
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
