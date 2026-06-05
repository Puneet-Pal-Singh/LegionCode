import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RUN_SUMMARY_REFRESH_EVENT } from "../lib/run-summary-events.js";
import { useEditArtifactReviewSource } from "./useEditArtifactReviewSource.js";

const mockGetLatestEditArtifactReviewSource = vi.hoisted(() =>
  vi.fn(async (_input: unknown) => null),
);
const mockGetEditArtifactReviewSourceByMessage = vi.hoisted(() =>
  vi.fn(async (_input: unknown) => null),
);

vi.mock("../lib/edit-artifacts-client.js", () => ({
  getLatestEditArtifactReviewSource: (input: unknown) =>
    mockGetLatestEditArtifactReviewSource(input),
  getEditArtifactReviewSourceByMessage: (input: unknown) =>
    mockGetEditArtifactReviewSourceByMessage(input),
}));

describe("useEditArtifactReviewSource", () => {
  beforeEach(() => {
    vi.useRealTimers();
    mockGetLatestEditArtifactReviewSource.mockClear();
    mockGetEditArtifactReviewSourceByMessage.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("caches latest artifact misses for the active run target", async () => {
    vi.useFakeTimers();
    renderHook(() =>
      useEditArtifactReviewSource({
        runId: "run-1",
        sessionId: "session-1",
        enabled: true,
      }),
    );

    await flushMicrotasks();
    expect(mockGetLatestEditArtifactReviewSource).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(
        new CustomEvent(RUN_SUMMARY_REFRESH_EVENT, {
          detail: { runId: "run-1" },
        }),
      );
      vi.advanceTimersByTime(800);
    });
    await flushMicrotasks();

    expect(mockGetLatestEditArtifactReviewSource).toHaveBeenCalledTimes(1);
  });

  it("clears cached misses when the run target changes", async () => {
    const { rerender } = renderHook(
      ({ runId }) =>
        useEditArtifactReviewSource({
          runId,
          sessionId: "session-1",
          enabled: true,
        }),
      {
        initialProps: { runId: "run-1" },
      },
    );

    await waitFor(() => {
      expect(mockGetLatestEditArtifactReviewSource).toHaveBeenCalledTimes(1);
    });

    rerender({ runId: "run-2" });

    await waitFor(() => {
      expect(mockGetLatestEditArtifactReviewSource).toHaveBeenCalledTimes(2);
    });
  });
});

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
