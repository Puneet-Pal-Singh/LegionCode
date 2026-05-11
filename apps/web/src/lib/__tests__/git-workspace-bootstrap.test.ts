import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetGitBootstrapInFlightForTests,
  bootstrapGitWorkspace,
} from "../git-workspace-bootstrap.js";

const request = {
  runId: "run-1",
  sessionId: "session-1",
  repositoryOwner: "owner",
  repositoryName: "repo",
  repositoryBranch: "main",
  repositoryBaseUrl: "https://github.com/owner/repo",
};

describe("bootstrapGitWorkspace", () => {
  beforeEach(() => {
    _resetGitBootstrapInFlightForTests();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("deduplicates concurrent bootstrap requests for the same workspace", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ status: "ready" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const [first, second] = await Promise.all([
      bootstrapGitWorkspace(request),
      bootstrapGitWorkspace(request),
    ]);

    expect(first).toEqual({ status: "ready" });
    expect(second).toEqual({ status: "ready" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reruns successful bootstrap requests after in-flight dedupe completes", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        new Response(JSON.stringify({ status: "ready" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    await bootstrapGitWorkspace(request);
    await bootstrapGitWorkspace(request);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces server error payload when bootstrap fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "workspace sync failed" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(bootstrapGitWorkspace(request)).rejects.toThrow(
      "workspace sync failed",
    );
  });
});
