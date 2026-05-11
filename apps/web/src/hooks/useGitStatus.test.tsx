import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGitStatus, _resetGitStatusStateForTests } from "./useGitStatus";
import {
  _resetRuntimeBootMonitorForTests,
  observeRuntimeBootId,
} from "../lib/runtime-boot-monitor";

vi.mock("./useRunContext", () => ({
  useRunContext: () => ({
    runId: null,
    sessionId: null,
  }),
}));

vi.mock("../lib/git-client.js", () => ({
  getGitStatus: vi.fn(),
}));

import { getGitStatus } from "../lib/git-client.js";

describe("useGitStatus", () => {
  beforeEach(() => {
    _resetGitStatusStateForTests();
    _resetRuntimeBootMonitorForTests();
    vi.clearAllMocks();
  });

  afterEach(() => {
    _resetGitStatusStateForTests();
    _resetRuntimeBootMonitorForTests();
  });

  it("keeps multiple consumers in sync when one refetches status", async () => {
    const getGitStatusMock = vi.mocked(getGitStatus);
    getGitStatusMock.mockResolvedValue({
      branch: "main",
      files: [],
      ahead: 0,
      behind: 0,
      hasStaged: false,
      hasUnstaged: false,
      gitAvailable: true,
    });

    const first = renderHook(() => useGitStatus("run-1", "session-1"));
    const second = renderHook(() => useGitStatus("run-1", "session-1"));

    await waitFor(() => {
      expect(first.result.current.status?.files).toEqual([]);
      expect(second.result.current.status?.files).toEqual([]);
    });

    getGitStatusMock.mockResolvedValue({
      branch: "main",
      files: [
        {
          path: "README.md",
          status: "modified",
          additions: 1,
          deletions: 0,
          isStaged: false,
        },
      ],
      ahead: 0,
      behind: 0,
      hasStaged: false,
      hasUnstaged: true,
      gitAvailable: true,
    });

    await act(async () => {
      await first.result.current.refetch(true);
    });

    await waitFor(() => {
      expect(first.result.current.status?.files).toHaveLength(1);
      expect(second.result.current.status?.files).toHaveLength(1);
      expect(second.result.current.status?.files[0]?.path).toBe("README.md");
    });
  });

  it("lets forced refetch bypass retry backoff after a transient failure", async () => {
    const getGitStatusMock = vi.mocked(getGitStatus);
    getGitStatusMock
      .mockRejectedValueOnce(new Error("temporary git failure"))
      .mockResolvedValueOnce({
        branch: "main",
        files: [],
        ahead: 0,
        behind: 0,
        hasStaged: false,
        hasUnstaged: false,
        gitAvailable: true,
      });

    const result = renderHook(() => useGitStatus("run-1", "session-1"));

    await waitFor(() => {
      expect(result.result.current.error).toBe("temporary git failure");
    });

    await act(async () => {
      await result.result.current.refetch(true);
    });

    expect(getGitStatusMock).toHaveBeenCalledTimes(2);
    expect(result.result.current.gitAvailable).toBe(true);
  });

  it("invalidates cached status when the brain runtime boot id changes", async () => {
    const getGitStatusMock = vi.mocked(getGitStatus);
    getGitStatusMock
      .mockResolvedValueOnce({
        branch: "main",
        files: [],
        ahead: 0,
        behind: 0,
        hasStaged: false,
        hasUnstaged: false,
        gitAvailable: true,
      })
      .mockResolvedValueOnce({
        branch: "main",
        files: [
          {
            path: "src/app.ts",
            status: "modified",
            additions: 2,
            deletions: 1,
            isStaged: false,
          },
        ],
        ahead: 0,
        behind: 0,
        hasStaged: false,
        hasUnstaged: true,
        gitAvailable: true,
      });

    const result = renderHook(() => useGitStatus("run-1", "session-1"));

    await waitFor(() => {
      expect(result.result.current.status?.files).toEqual([]);
    });

    act(() => {
      observeRuntimeBootId("boot-1");
      observeRuntimeBootId("boot-2");
    });

    await waitFor(() => {
      expect(result.result.current.status?.files[0]?.path).toBe("src/app.ts");
    });
    expect(getGitStatusMock).toHaveBeenCalledTimes(2);
  });
});
