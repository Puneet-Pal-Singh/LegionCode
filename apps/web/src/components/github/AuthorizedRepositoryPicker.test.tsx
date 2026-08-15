import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthorizedRepositoryPicker } from "./AuthorizedRepositoryPicker";
import * as GitHubService from "../../services/GitHubService";

vi.mock("../../services/GitHubService", () => ({
  listRepositories: vi.fn(),
  listBranches: vi.fn(),
  initiateGitHubReauthorization: vi.fn(),
}));

const repository = {
  id: 42,
  name: "shadowbox",
  full_name: "legioncode/shadowbox",
  owner: { login: "legioncode", avatar_url: "" },
  description: "Agent workspace",
  private: true,
  html_url: "https://github.com/legioncode/shadowbox",
  clone_url: "https://github.com/legioncode/shadowbox.git",
  default_branch: "main",
  stargazers_count: 0,
  language: "TypeScript",
  updated_at: new Date().toISOString(),
};

describe("AuthorizedRepositoryPicker", () => {
  beforeEach(() => {
    vi.mocked(GitHubService.listRepositories).mockResolvedValue([repository]);
    vi.mocked(GitHubService.listBranches).mockResolvedValue([
      {
        name: "main",
        protected: true,
        commit: { sha: "abc1234", url: "https://api.github.test/commit" },
      },
      {
        name: "feature/onboarding",
        protected: false,
        commit: { sha: "def5678", url: "https://api.github.test/commit-2" },
      },
    ]);
  });

  it("selects an authorized repository and branch before opening a workspace", async () => {
    const onRepoSelect = vi.fn(async () => undefined);
    render(<AuthorizedRepositoryPicker onRepoSelect={onRepoSelect} />);

    const repoButton = await screen.findByRole("button", {
      name: /legioncode\/shadowbox/i,
    });
    fireEvent.click(repoButton);

    const branch = await screen.findByLabelText("Starting branch");
    fireEvent.change(branch, { target: { value: "feature/onboarding" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Open legioncode/shadowbox" }),
    );

    await waitFor(() =>
      expect(onRepoSelect).toHaveBeenCalledWith(
        repository,
        "feature/onboarding",
      ),
    );
  });

  it("offers one repair action when no repositories are granted", async () => {
    vi.mocked(GitHubService.listRepositories).mockResolvedValue([]);
    render(<AuthorizedRepositoryPicker onRepoSelect={vi.fn()} />);

    expect(
      await screen.findByRole("heading", {
        name: "No repositories are available",
      }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Manage GitHub access/i }));
    expect(GitHubService.initiateGitHubReauthorization).toHaveBeenCalledTimes(1);
  });
});
