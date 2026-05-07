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

  it("treats missing remote tree refs as unavailable metadata instead of server failure", async () => {
    const getTree = vi
      .fn()
      .mockRejectedValue(
        new Error('GitHub API error (404): {"message":"Not Found"}'),
      );
    mockGetGitHubClient.mockResolvedValue({
      client: { getTree },
      userId: "user-1",
      session: {},
    });

    const response = await GitHubController.getTree(
      new Request(
        "https://brain.local/api/github/tree?owner=shadowbox&repo=shadowbox&sha=feat/local-only",
      ),
      createEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      tree: [],
      unavailable: true,
      reason: "ref_not_found",
    });
  });
});

function createEnv(): Env {
  return {
    NODE_ENV: "test",
  } as unknown as Env;
}
