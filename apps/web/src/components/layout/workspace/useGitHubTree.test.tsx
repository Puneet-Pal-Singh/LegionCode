import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGitHubTree } from "./useGitHubTree";

const mockUseGitHub = vi.hoisted(() => vi.fn());
const mockGetRepositoryTree = vi.hoisted(() => vi.fn());

vi.mock("../../github/GitHubContextProvider", () => ({
  useGitHub: () => mockUseGitHub(),
}));

vi.mock("../../../services/GitHubService", () => ({
  getRepositoryTree: (...args: unknown[]) => mockGetRepositoryTree(...args),
}));

vi.mock("../../../contexts/AuthContext", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));

describe("useGitHubTree", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockUseGitHub.mockReturnValue({
      repo: {
        owner: { login: "Puneet-Pal-Singh" },
        name: "career-crew",
        full_name: "Puneet-Pal-Singh/career-crew",
      },
      branch: "main",
      isLoaded: true,
    });

    mockGetRepositoryTree.mockResolvedValue([
      { path: "README.md", type: "blob", sha: "1" },
    ]);
  });

  it("treats bare repository names as matching the current full_name context", async () => {
    const { result } = renderHook(() => useGitHubTree("career-crew"));

    await waitFor(() => {
      expect(result.current.repoTree).toEqual([
        { path: "README.md", type: "blob", sha: "1" },
      ]);
    });

    expect(mockGetRepositoryTree).toHaveBeenCalledWith(
      "Puneet-Pal-Singh",
      "career-crew",
      "main",
      "user-1",
    );
    expect(result.current.isLoadingTree).toBe(false);
    expect(result.current.isContextMismatch).toBe(false);
    expect(result.current.repo?.full_name).toBe(
      "Puneet-Pal-Singh/career-crew",
    );
  });

  it("clears the tree and stays in loading mismatch mode for a different repository", async () => {
    const { result } = renderHook(() => useGitHubTree("different-repo"));

    await waitFor(() => {
      expect(result.current.repoTree).toEqual([]);
    });

    expect(mockGetRepositoryTree).not.toHaveBeenCalled();
    expect(result.current.isLoadingTree).toBe(true);
    expect(result.current.isContextMismatch).toBe(true);
    expect(result.current.repo).toBeNull();
  });
});
