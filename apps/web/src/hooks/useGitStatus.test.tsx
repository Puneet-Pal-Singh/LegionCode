import { act, renderHook, waitFor } from "@testing-library/react";
import type { GitStatusReady, GitStatusResponse } from "@repo/shared-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGitStatus, _resetGitStatusStateForTests } from "./useGitStatus";
import {
  _resetRuntimeBootMonitorForTests,
  observeRuntimeBootId,
  subscribeRuntimeBootChanges,
} from "../lib/runtime-boot-monitor";

vi.mock("./useRunContext", () => ({
  useOptionalRunContext: () => ({
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

  it("ignores stale status responses after a forced refetch starts", async () => {
    const initialStatus = createDeferredStatus();
    const forcedStatus = createDeferredStatus();
    const getGitStatusMock = vi.mocked(getGitStatus);
    getGitStatusMock
      .mockReturnValueOnce(initialStatus.promise)
      .mockReturnValueOnce(forcedStatus.promise);

    const result = renderHook(() => useGitStatus("run-1", "session-1"));

    await waitFor(() => {
      expect(getGitStatusMock).toHaveBeenCalledTimes(1);
    });

    let refetchPromise!: Promise<void>;
    act(() => {
      refetchPromise = result.result.current.refetch(true);
    });

    await waitFor(() => {
      expect(getGitStatusMock).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      forcedStatus.resolve(
        buildGitStatus({
          files: [
            {
              path: "src/app.ts",
              status: "modified",
              additions: 2,
              deletions: 1,
              isStaged: false,
            },
          ],
          hasUnstaged: true,
        }),
      );
      await refetchPromise;
    });

    expect(result.result.current.status?.files[0]?.path).toBe("src/app.ts");

    await act(async () => {
      initialStatus.resolve(buildGitStatus());
      await initialStatus.promise;
    });

    expect(result.result.current.status?.files[0]?.path).toBe("src/app.ts");
  });

  it("does not surface an error while session context is still hydrating", async () => {
    const getGitStatusMock = vi.mocked(getGitStatus);

    const result = renderHook(() => useGitStatus("run-1", undefined));

    await waitFor(() => {
      expect(result.result.current.loading).toBe(false);
    });
    expect(result.result.current.error).toBeNull();
    expect(getGitStatusMock).not.toHaveBeenCalled();
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
    expect(getGitStatusMock).toHaveBeenCalledTimes(3);
  });

  it("isolates runtime boot listener and localStorage failures", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const readFailure = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementationOnce(() => {
        throw new Error("blocked storage");
      });

    expect(() => observeRuntimeBootId("boot-blocked")).not.toThrow();
    readFailure.mockRestore();

    const throwingListener = vi.fn(() => {
      throw new Error("listener failed");
    });
    const healthyListener = vi.fn();
    const unsubscribeThrowing = subscribeRuntimeBootChanges(throwingListener);
    const unsubscribeHealthy = subscribeRuntimeBootChanges(healthyListener);

    observeRuntimeBootId("boot-1");
    observeRuntimeBootId("boot-2");

    expect(throwingListener).toHaveBeenCalledWith("boot-2");
    expect(healthyListener).toHaveBeenCalledWith("boot-2");

    unsubscribeThrowing();
    unsubscribeHealthy();
    consoleError.mockRestore();
    consoleWarn.mockRestore();
  });
});

function buildGitStatus(
  overrides: Partial<GitStatusReady> = {},
): GitStatusReady {
  return {
    branch: "main",
    files: [],
    ahead: 0,
    behind: 0,
    hasStaged: false,
    hasUnstaged: false,
    gitAvailable: true,
    ...overrides,
  };
}

function createDeferredStatus(): {
  promise: Promise<GitStatusResponse>;
  resolve: (status: GitStatusResponse) => void;
} {
  let resolve: (status: GitStatusResponse) => void = () => {};
  const promise = new Promise<GitStatusResponse>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}
