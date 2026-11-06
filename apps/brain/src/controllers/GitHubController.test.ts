import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubAPIError } from "@legioncode/github-bridge";
import { readRepositoryTree } from "../services/RepositoryReadService";

describe("RepositoryReadService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the default branch tree when a local-only task branch is not on GitHub", async () => {
    const getTree = vi
      .fn()
      .mockRejectedValueOnce(new GitHubAPIError(404, "Not Found", false))
      .mockResolvedValueOnce([{ path: "README.md", type: "blob", sha: "1" }]);
    const getRepository = vi.fn().mockResolvedValue({ default_branch: "main" });

    const response = await readRepositoryTree(
      { getTree, getRepository } as never,
      { owner: "legioncode", repo: "legioncode", sha: "feat/local-only" },
    );

    expect(response).toEqual({
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
