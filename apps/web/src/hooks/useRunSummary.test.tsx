import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RUN_SUMMARY_REFRESH_EVENT } from "../lib/run-summary-events.js";
import {
  __resetRunSummaryRequestCacheForTests,
  useRunSummary,
} from "./useRunSummary.js";

vi.mock("../lib/platform-endpoints.js", () => ({
  getBrainHttpBase: () => "https://brain.local",
}));

describe("useRunSummary", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(
        JSON.stringify({ runId: "run-1", status: "completed" }),
        { status: 200 },
      );
    });
  });

  afterEach(() => {
    __resetRunSummaryRequestCacheForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("stops refresh fetches after a terminal summary without pending approval", async () => {
    let now = 2_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetchSpy = vi.mocked(globalThis.fetch);

    const { result } = renderHook(() => useRunSummary("run-1", true));

    await waitFor(() => {
      expect(result.current.summary?.status).toBe("completed");
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    now += 2_000;
    act(() => {
      window.dispatchEvent(
        new CustomEvent(RUN_SUMMARY_REFRESH_EVENT, {
          detail: { runId: "run-1" },
        }),
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not fetch summaries when canonical lifecycle replay owns the run", async () => {
    let now = 2_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetchSpy = vi.mocked(globalThis.fetch);

    const { result } = renderHook(() => useRunSummary("run-approval", false));

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.summary).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(0);

    now += 2_000;
    act(() => {
      window.dispatchEvent(
        new CustomEvent(RUN_SUMMARY_REFRESH_EVENT, {
          detail: { runId: "run-approval" },
        }),
      );
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it("throttles missing summary refreshes until a manual retry window opens", async () => {
    let now = 2_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetchSpy = vi
      .mocked(globalThis.fetch)
      .mockResolvedValueOnce(new Response("Not Found", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ runId: "missing-run", status: "RUNNING" }),
          { status: 200 },
        ),
      );

    renderHook(() => useRunSummary("missing-run", true));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    now += 2_000;
    act(() => {
      window.dispatchEvent(
        new CustomEvent(RUN_SUMMARY_REFRESH_EVENT, {
          detail: { runId: "missing-run" },
        }),
      );
    });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    now += 10_000;
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

  it("does not fetch summaries for run event stream refreshes", async () => {
    let now = 2_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetchSpy = vi.mocked(globalThis.fetch);

    renderHook(() => useRunSummary("run-1", true));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    now += 20_000;
    act(() => {
      window.dispatchEvent(
        new CustomEvent(RUN_SUMMARY_REFRESH_EVENT, {
          detail: { runId: "run-1", source: "run-event-stream" },
        }),
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not poll missing legacy summaries", async () => {
    vi.useFakeTimers();
    let now = 2_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetchSpy = vi
      .mocked(globalThis.fetch)
      .mockResolvedValueOnce(new Response("Not Found", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ runId: "late-run", status: "RUNNING" }), {
          status: 200,
        }),
      );

    const { result } = renderHook(() => useRunSummary("late-run", true));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.summary).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    now += 30_000;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.current.summary).toBeNull();
  });

  it("settles a running legacy summary from an explicit refresh event", async () => {
    let now = 2_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetchSpy = vi
      .mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ runId: "run-1", status: "running" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ runId: "run-1", status: "completed" }), {
          status: 200,
        }),
      );

    const { result } = renderHook(() => useRunSummary("run-1", true));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.summary?.status).toBe("running");

    now += 30_000;
    act(() => {
      window.dispatchEvent(
        new CustomEvent(RUN_SUMMARY_REFRESH_EVENT, {
          detail: { runId: "run-1", source: "manual" },
        }),
      );
    });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(result.current.summary?.status).toBe("completed");
    });
  });

  it("coalesces duplicate fetches across multiple summary consumers", async () => {
    let now = 2_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetchSpy = vi
      .mocked(globalThis.fetch)
      .mockResolvedValue(
        new Response(JSON.stringify({ runId: "run-1", status: "running" }), {
          status: 200,
        }),
      );

    const first = renderHook(() => useRunSummary("run-1", true));
    const second = renderHook(() => useRunSummary("run-1", true));

    await waitFor(() => {
      expect(first.result.current.summary?.status).toBe("running");
      expect(second.result.current.summary?.status).toBe("running");
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);

    now += 250;
    act(() => {
      window.dispatchEvent(
        new CustomEvent(RUN_SUMMARY_REFRESH_EVENT, {
          detail: { runId: "run-1" },
        }),
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
