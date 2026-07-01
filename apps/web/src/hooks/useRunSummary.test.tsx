import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RUN_SUMMARY_REFRESH_EVENT } from "../lib/run-summary-events.js";
import { useRunSummary } from "./useRunSummary.js";

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

  it("refreshes non-polling terminal summaries while approval is pending", async () => {
    let now = 2_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetchSpy = vi.mocked(globalThis.fetch);
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          runId: "run-approval",
          status: "completed",
          pendingApproval: {
            requestId: "approval-1",
            runId: "run-approval",
            origin: "agent",
            category: "shell_command",
            title: "Run command",
            reason: "Needs approval",
            actionFingerprint: "shell_command:test",
            availableDecisions: ["allow_once", "deny"],
            createdAt: "2026-06-02T00:00:00.000Z",
          },
        }),
        { status: 200 },
      ),
    );

    const { result } = renderHook(() => useRunSummary("run-approval", false));

    await waitFor(() => {
      expect(result.current.summary?.pendingApproval).toBeTruthy();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    now += 2_000;
    act(() => {
      window.dispatchEvent(
        new CustomEvent(RUN_SUMMARY_REFRESH_EVENT, {
          detail: { runId: "run-approval" },
        }),
      );
    });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  it("retries after Brain reports the run missing before it is created", async () => {
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
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  it("polls missing canonical summaries until the run record appears", async () => {
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

    const { result } = renderHook(() => useRunSummary("late-run", false));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.summary).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    now += 5_000;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.current.summary?.status).toBe("RUNNING");
  });

  it("settles a running canonical summary after stream polling stops", async () => {
    vi.useFakeTimers();
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

    const { result } = renderHook(() => useRunSummary("run-1", false));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.summary?.status).toBe("running");

    now += 5_000;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.current.summary?.status).toBe("completed");
  });
});
