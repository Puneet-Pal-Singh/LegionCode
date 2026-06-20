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
    vi.useRealTimers();
    setVisibilityState(originalVisibilityState);
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

  it("retries refresh requests when the run is not created yet", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("Not Found", { status: 404 }))
      .mockResolvedValueOnce(
        createEventsResponse(
          createMessageEvent("pending-run", "evt-created", "Created"),
        ),
      );

    const { result } = renderHook(() => useRunEvents("pending-run"));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    act(() => {
      window.dispatchEvent(
        new CustomEvent(RUN_SUMMARY_REFRESH_EVENT, {
          detail: { runId: "pending-run" },
        }),
      );
    });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(result.current.events[0]?.eventId).toBe("evt-created");
    });
  });

  it("reconnects the event stream when Brain creates the run after submit", async () => {
    vi.useFakeTimers();
    let streamRequests = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (!url.includes("/stream?")) {
        return new Response("Not Found", { status: 404 });
      }
      streamRequests += 1;
      return streamRequests === 1
        ? new Response("Not Found", { status: 404 })
        : createStreamResponse(
            createMessageEvent("run-created-late", "evt-live", "Live event"),
          );
    });

    const { result } = renderHook(() => useRunEvents("run-created-late", true));
    await flushMicrotasks();
    expect(streamRequests).toBe(1);

    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    await flushMicrotasks();

    expect(streamRequests).toBe(2);
    expect(
      result.current.events.some((event) => event.eventId === "evt-live"),
    ).toBe(true);
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

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: state,
  });
}
