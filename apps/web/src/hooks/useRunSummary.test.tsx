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
});
