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
  });

  it("continues refresh fetches while polling after a terminal summary", async () => {
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

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
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
});
