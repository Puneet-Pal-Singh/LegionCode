import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVITY_PART_KINDS } from "@repo/shared-types";
import { RUN_SUMMARY_REFRESH_EVENT } from "../lib/run-summary-events.js";
import { useRunActivityFeed } from "./useRunActivityFeed.js";

vi.mock("../lib/platform-endpoints.js", () => ({
  runActivityPath: (runId: string) =>
    `https://brain.local/api/run/activity?runId=${encodeURIComponent(runId)}`,
}));

describe("useRunActivityFeed", () => {
  const originalVisibilityState = document.visibilityState;

  beforeEach(() => {
    vi.restoreAllMocks();
    setVisibilityState("visible");
  });

  afterEach(() => {
    vi.useRealTimers();
    setVisibilityState(originalVisibilityState);
  });

  it("hydrates the activity feed and refreshes through the runtime bridge", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        createResponse("run-1", [
          createTextPart("run-1", "Inspect the app."),
        ]),
      )
      .mockResolvedValueOnce(
        createResponse("run-1", [
          {
            id: "text-1",
            runId: "run-1",
            sessionId: "session-1",
            turnId: "turn-1",
            kind: ACTIVITY_PART_KINDS.TEXT,
            createdAt: "2026-03-24T10:00:00.000Z",
            updatedAt: "2026-03-24T10:00:00.000Z",
            source: "brain",
            role: "user",
            content: "Inspect the app.",
          },
          {
            id: "reasoning-1",
            runId: "run-1",
            sessionId: "session-1",
            turnId: "turn-1",
            kind: ACTIVITY_PART_KINDS.REASONING,
            createdAt: "2026-03-24T10:00:01.000Z",
            updatedAt: "2026-03-24T10:00:01.000Z",
            source: "brain",
            label: "Analyzing repository",
            summary: "Preparing the plan.",
            phase: "planning",
            status: "completed",
          },
        ]),
      );

    const { result } = renderHook(() => useRunActivityFeed("run-1"));

    await waitFor(() => {
      expect(result.current.feed?.items).toHaveLength(1);
    });

    act(() => {
      window.dispatchEvent(
        new CustomEvent(RUN_SUMMARY_REFRESH_EVENT, {
          detail: { runId: "run-1" },
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.feed?.items).toHaveLength(2);
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      "https://brain.local/api/run/activity?runId=run-1",
      { credentials: "include" },
    );
  });

  it("stops polling the current run after an authorization failure", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response("Unauthorized", {
          status: 401,
          statusText: "Unauthorized",
        }),
    );

    renderHook(() => useRunActivityFeed("run-1", true));

    await flushMicrotasks();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    await flushMicrotasks();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("backs off after a temporary network failure while polling", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("Failed to fetch"));

    renderHook(() => useRunActivityFeed("run-1", true));

    await flushMicrotasks();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    await flushMicrotasks();

    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    await flushMicrotasks();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does not expose the previous run feed during a run switch", async () => {
    let resolveRunTwoFetch: ((response: Response) => void) | null = null;
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        createResponse("run-1", [createTextPart("run-1", "Old run")]),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveRunTwoFetch = resolve;
          }),
      );

    const { result, rerender } = renderHook(
      ({ runId }) => useRunActivityFeed(runId),
      {
        initialProps: { runId: "run-1" },
      },
    );

    await waitFor(() => {
      expect(result.current.feed?.runId).toBe("run-1");
    });

    rerender({ runId: "run-2" });

    expect(result.current.feed).toBeNull();

    act(() => {
      resolveRunTwoFetch?.(
        createResponse("run-2", [createTextPart("run-2", "New run")]),
      );
    });

    await waitFor(() => {
      expect(result.current.feed?.runId).toBe("run-2");
    });
  });
});

function createResponse(runId: string, items: unknown[]): Response {
  return new Response(
    JSON.stringify({
      runId,
      sessionId: "session-1",
      status: "RUNNING",
      items,
    }),
    { status: 200 },
  );
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

function createTextPart(runId: string, content: string): unknown {
  return {
    id: `${runId}-text-1`,
    runId,
    sessionId: "session-1",
    turnId: `${runId}-turn-1`,
    kind: ACTIVITY_PART_KINDS.TEXT,
    createdAt: "2026-03-24T10:00:00.000Z",
    updatedAt: "2026-03-24T10:00:00.000Z",
    source: "brain",
    role: "user",
    content,
  };
}
