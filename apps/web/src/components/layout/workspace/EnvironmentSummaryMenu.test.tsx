import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Repository } from "../../../services/GitHubService";
import { EnvironmentSummaryMenu } from "./EnvironmentSummaryMenu";

const serviceMocks = vi.hoisted(() => ({
  listBranches: vi.fn(),
  listOpenPullRequests: vi.fn(),
}));

vi.mock("../../../services/GitHubService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../services/GitHubService")>()),
  ...serviceMocks,
}));

const repo: Repository = {
  id: 1,
  name: "shadowbox",
  full_name: "legion/shadowbox",
  owner: { login: "legion", avatar_url: "" },
  description: null,
  private: false,
  html_url: "https://github.com/legion/shadowbox",
  clone_url: "https://github.com/legion/shadowbox.git",
  default_branch: "main",
  stargazers_count: 0,
  language: "TypeScript",
  updated_at: "2026-06-19T00:00:00Z",
};

describe("EnvironmentSummaryMenu", () => {
  beforeEach(() => {
    serviceMocks.listBranches.mockResolvedValue([
      { name: "main", protected: true, commit: { sha: "1", url: "" } },
      { name: "feat/menu", protected: false, commit: { sha: "2", url: "" } },
    ]);
    serviceMocks.listOpenPullRequests.mockResolvedValue([]);
  });

  it("shows only available actions and closes on outside click", () => {
    render(
      <div>
        <EnvironmentSummaryMenu
          repo={null}
          branch="main"
          changedFileCount={0}
          onBranchChange={vi.fn()}
          onOpenChanges={vi.fn()}
          onOpenCommit={vi.fn()}
        />
        <button type="button">Outside</button>
      </div>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Toggle environment summary" }),
    );
    expect(
      screen
        .getByRole("button", { name: "Toggle environment summary" })
        .querySelector(".lucide-list"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Toggle environment summary" }),
    ).toHaveClass("p-1.5");
    expect(
      screen.getByRole("dialog", { name: "Environment summary" }),
    ).toHaveClass("w-[340px]");
    expect(
      screen
        .getByRole("dialog", { name: "Environment summary" })
        .querySelector(".lucide-plus"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("LegionCode cloud")).toBeInTheDocument();
    expect(screen.queryByText("Changes")).not.toBeInTheDocument();
    expect(screen.queryByText("Commit or push")).not.toBeInTheDocument();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
    expect(
      screen.queryByRole("dialog", { name: "Environment summary" }),
    ).not.toBeInTheDocument();
  });

  it("switches branches and links the active pull request", async () => {
    const onBranchChange = vi.fn();
    serviceMocks.listOpenPullRequests.mockResolvedValue([
      {
        number: 42,
        title: "feat(web): add environment summary",
        url: "https://github.com/legion/shadowbox/pull/42",
        state: "open",
        head: "main",
        base: "main",
      },
    ]);
    render(
      <EnvironmentSummaryMenu
        repo={repo}
        branch="main"
        changedFileCount={3}
        onBranchChange={onBranchChange}
        onOpenChanges={vi.fn()}
        onOpenCommit={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Toggle environment summary" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: /add environment summary/i }),
      ).toHaveAttribute("href", "https://github.com/legion/shadowbox/pull/42"),
    );
    fireEvent.click(screen.getByRole("button", { name: "main" }));
    expect(
      within(
        screen.getByRole("dialog", { name: "Environment summary" }),
      ).queryByPlaceholderText("Find a branch..."),
    ).not.toBeInTheDocument();
    await waitFor(() => screen.getByRole("button", { name: "feat/menu" }));
    fireEvent.click(screen.getByRole("button", { name: "feat/menu" }));
    expect(onBranchChange).toHaveBeenCalledWith("feat/menu");
  });
});
