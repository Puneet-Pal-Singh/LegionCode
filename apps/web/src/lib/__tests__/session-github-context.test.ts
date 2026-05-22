import { describe, expect, it } from "vitest";
import { inferSessionGitHubContext } from "../session-github-context.js";

describe("inferSessionGitHubContext", () => {
  it("reconstructs session context from a full repository name", () => {
    expect(
      inferSessionGitHubContext("owner/repo", null, ""),
    ).toEqual({
      repoOwner: "owner",
      repoName: "repo",
      fullName: "owner/repo",
      branch: "main",
    });
  });

  it("reuses the current branch when the active repo matches", () => {
    expect(
      inferSessionGitHubContext(
        "owner/repo",
        {
          id: 1,
          name: "repo",
          full_name: "owner/repo",
          owner: { login: "owner", avatar_url: "" },
          description: null,
          private: false,
          html_url: "https://github.com/owner/repo",
          clone_url: "https://github.com/owner/repo.git",
          default_branch: "develop",
          stargazers_count: 0,
          language: null,
          updated_at: new Date().toISOString(),
        },
        "feature/review-ui",
      ),
    ).toEqual({
      repoOwner: "owner",
      repoName: "repo",
      fullName: "owner/repo",
      branch: "feature/review-ui",
    });
  });

  it("returns null for repository labels that are not owner/name pairs", () => {
    expect(inferSessionGitHubContext("career-crew", null, "")).toBeNull();
    expect(inferSessionGitHubContext("owner/repo/extra", null, "")).toBeNull();
  });
});
