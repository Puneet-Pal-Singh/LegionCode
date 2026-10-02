import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TopNavBar } from "./TopNavBar";

vi.mock("../navigation/OpenDropdown", () => ({
  OpenDropdown: ({ onSelect }: { onSelect?: (ide: string) => void }) => (
    <button type="button" onClick={() => onSelect?.("vscode")}>
      Open IDE
    </button>
  ),
}));

vi.mock("../auth/GitHubLoginButton", () => ({
  GitHubLoginButton: ({ onClick }: { onClick: () => void }) => (
    <button type="button" onClick={onClick}>
      Connect GitHub
    </button>
  ),
}));

vi.mock("../navigation/TopEnvironmentSummary", () => ({
  TopEnvironmentSummary: ({ onOpenChanges }: { onOpenChanges: () => void }) => (
    <button type="button" onClick={onOpenChanges}>
      Toggle summary
    </button>
  ),
}));

describe("TopNavBar shared adapter", () => {
  it("routes review, IDE, and summary actions", () => {
    const onReview = vi.fn();
    const onOpenIde = vi.fn();
    const onOpenChanges = vi.fn();
    const onToggleRightSidebar = vi.fn();

    render(
      <TopNavBar
        onReview={onReview}
        onOpenIde={onOpenIde}
        onToggleRightSidebar={onToggleRightSidebar}
        isAuthenticated
        environmentSummary={{
          repo: null,
          branch: "main",
          onBranchChange: vi.fn(),
          onOpenChanges,
          onOpenCommit: vi.fn(),
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(screen.getByRole("button", { name: "Open IDE" }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle summary" }));
    expect(onReview).toHaveBeenCalledOnce();
    expect(onOpenIde).toHaveBeenCalledWith("vscode");
    expect(onOpenChanges).toHaveBeenCalledOnce();
    expect(onToggleRightSidebar).not.toHaveBeenCalled();
  });

  it("keeps review controls hidden while the right panel is open", () => {
    render(
      <TopNavBar
        onReview={vi.fn()}
        onToggleRightSidebar={vi.fn()}
        isRightSidebarOpen
        isAuthenticated
      />,
    );

    expect(screen.queryByRole("button", { name: "Review" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open IDE" })).toBeInTheDocument();
  });
});
