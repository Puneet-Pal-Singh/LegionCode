import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WelcomeBranchSelector } from "./WelcomeBranchSelector";

const mocks = vi.hoisted(() => ({
  listBranches: vi.fn(),
  switchBranch: vi.fn(),
}));

vi.mock("../../services/GitHubService", () => ({
  listBranches: mocks.listBranches,
}));

vi.mock("../github/GitHubContextProvider", () => ({
  useGitHub: () => ({
    repo: {
      name: "shadowbox",
      owner: { login: "legion" },
      default_branch: "main",
    },
    branch: "main",
    switchBranch: mocks.switchBranch,
  }),
}));

describe("WelcomeBranchSelector", () => {
  beforeEach(() => {
    mocks.switchBranch.mockReset();
    mocks.listBranches.mockResolvedValue([
      { name: "main", protected: true, commit: { sha: "1", url: "" } },
      { name: "feat/menu", protected: false, commit: { sha: "2", url: "" } },
    ]);
  });

  it("selects a branch from the welcome composer", async () => {
    render(<WelcomeBranchSelector />);
    fireEvent.click(screen.getByRole("button", { name: "Select branch" }));
    await waitFor(() => screen.getByRole("button", { name: "feat/menu" }));
    fireEvent.click(screen.getByRole("button", { name: "feat/menu" }));
    expect(mocks.switchBranch).toHaveBeenCalledWith("feat/menu");
  });

  it("closes its popover when clicking outside", async () => {
    render(
      <div>
        <WelcomeBranchSelector />
        <button type="button">Outside</button>
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Select branch" }));
    await waitFor(() => screen.getByPlaceholderText("Search branches"));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
    expect(
      screen.queryByPlaceholderText("Search branches"),
    ).not.toBeInTheDocument();
  });
});
