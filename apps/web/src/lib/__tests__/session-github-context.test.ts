import { describe, expect, it } from "vitest";
import {
  inferSessionGitHubContext,
  resolveTaskRepositoryFullName,
} from "../session-github-context.js";

const currentRepo = {
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
};

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
        currentRepo,
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

describe("resolveTaskRepositoryFullName", () => {
  it("uses the active GitHub repository when no repository label is provided", () => {
    expect(resolveTaskRepositoryFullName(undefined, currentRepo)).toBe(
      "owner/repo",
    );
  });

  it("keeps canonical owner/name repositories", () => {
    expect(resolveTaskRepositoryFullName("other/project", currentRepo)).toBe(
      "other/project",
    );
  });

  it("normalizes spaced owner/name repositories", () => {
    expect(resolveTaskRepositoryFullName("owner / repo", currentRepo)).toBe(
      "owner/repo",
    );
  });

  it("resolves the active repository name to the canonical full name", () => {
    expect(resolveTaskRepositoryFullName("repo", currentRepo)).toBe(
      "owner/repo",
    );
  });

  it("rejects bare repository labels without a matching active repository", () => {
    expect(resolveTaskRepositoryFullName("career-crew", currentRepo)).toBeNull();
    expect(resolveTaskRepositoryFullName("career-crew", null)).toBeNull();
  });
});
