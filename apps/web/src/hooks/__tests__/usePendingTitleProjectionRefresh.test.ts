import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePendingTitleProjectionRefresh } from "../usePendingTitleProjectionRefresh";
import { SessionStateService } from "../../services/SessionStateService";
import type { AgentSession } from "../../types/session";

const preview = {
  id: "session",
  name: "Fix login timeout",
  titleSource: "preview",
  titleVersion: 2,
  titleStatus: "pending",
  status: "completed",
  mode: "build",
  repository: "repo",
  activeRunId: "run_title",
  runIds: ["run_title"],
  pinnedAt: null,
  archivedAt: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
} satisfies AgentSession;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("durable pending title refresh", () => {
  it("observes failure settlement after reload and stops polling a failed preview", async () => {
    const failed = {
      ...preview,
      titleStatus: "failed" as const,
      titleVersion: 3,
    };
    const hydrate = vi
      .spyOn(SessionStateService, "hydrateSessionsFromServer")
      .mockResolvedValue({ [preview.id]: failed });
    const onServerSessions = vi.fn();
    const { rerender } = renderHook(
      ({ sessions }) =>
        usePendingTitleProjectionRefresh({
          enabled: true,
          sessions,
          onServerSessions,
        }),
      { initialProps: { sessions: [preview] as AgentSession[] } },
    );
    await act(() => vi.advanceTimersByTimeAsync(750));
    expect(onServerSessions).toHaveBeenCalledWith({ [preview.id]: failed });
    rerender({ sessions: [failed] });
    await act(() => vi.advanceTimersByTimeAsync(24000));
    expect(hydrate).toHaveBeenCalledOnce();
  });

  it.each(["ready", "failed"] as const)(
    "does not poll a %s preview on a fresh mount",
    async (titleStatus) => {
      const hydrate = vi.spyOn(
        SessionStateService,
        "hydrateSessionsFromServer",
      );
      renderHook(() =>
        usePendingTitleProjectionRefresh({
          enabled: true,
          sessions: [{ ...preview, titleStatus }],
          onServerSessions: vi.fn(),
        }),
      );
      await act(() => vi.advanceTimersByTimeAsync(24000));
      expect(hydrate).not.toHaveBeenCalled();
    },
  );
});
