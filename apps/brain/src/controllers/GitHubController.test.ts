import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubController } from "./GitHubController";
import type { Env } from "../types/ai";

const mockGetGitHubClient = vi.hoisted(() => vi.fn());

vi.mock("../services/AuthService", () => ({
  getGitHubClient: mockGetGitHubClient,
  isSessionStoreUnavailableError: (error: unknown) =>
    error instanceof Error && error.name === "SessionStoreUnavailableError",
}));

describe("GitHubController", () => {
  beforeEach(() => {
    mockGetGitHubClient.mockReset();
  });

  it("uses the default branch tree when a local-only task branch is not on GitHub", async () => {
    const getTree = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('GitHub API error (404): {"message":"Not Found"}'),
      )
      .mockResolvedValueOnce([{ path: "README.md", type: "blob", sha: "1" }]);
    const getRepository = vi.fn().mockResolvedValue({ default_branch: "main" });
    mockGetGitHubClient.mockResolvedValue({
      client: { getTree, getRepository },
      userId: "user-1",
      session: {},
    });

    const response = await GitHubController.getTree(
      new Request(
        "https://brain.local/api/github/tree?owner=legioncode&repo=legioncode&sha=feat/local-only",
      ),
      createEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      tree: [{ path: "README.md", type: "blob", sha: "1" }],
      requestedRefUnavailable: true,
      resolvedRef: "main",
    });
    expect(getRepository).toHaveBeenCalledWith("legioncode", "legioncode");
    expect(getTree).toHaveBeenNthCalledWith(
      1,
      "legioncode",
      "legioncode",
      "feat/local-only",
    );
    expect(getTree).toHaveBeenNthCalledWith(
      2,
      "legioncode",
      "legioncode",
      "main",
    );
  });
});

function createEnv(): Env {
  return {
    NODE_ENV: "test",
  } as unknown as Env;
}
