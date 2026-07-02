import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TopNavBar } from "./TopNavBar";

vi.mock("../navigation/OpenDropdown", () => ({
  OpenDropdown: () => <button type="button">Open</button>,
}));

vi.mock("../auth/GitHubLoginButton", () => ({
  GitHubLoginButton: ({ onClick }: { onClick: () => void }) => (
    <button type="button" onClick={onClick}>
      Connect GitHub
    </button>
  ),
}));

vi.mock("../navigation/TopEnvironmentSummary", () => ({
  TopEnvironmentSummary: ({ enabled }: { enabled?: boolean }) => (
    <button type="button" data-enabled={String(enabled)}>
      Toggle summary
    </button>
  ),
}));

const environmentSummary = {
  sessionId: "session-1",
  runId: "run-1",
  repo: null,
  branch: "main",
  onBranchChange: vi.fn(),
  onOpenChanges: vi.fn(),
  onOpenCommit: vi.fn(),
};

describe("TopNavBar", () => {
  it("provides vertical space around header controls", () => {
    render(<TopNavBar isAuthenticated />);

    expect(screen.getByRole("banner")).toHaveClass("h-12");
    expect(
      screen.queryByRole("button", { name: "Toggle summary" }),
    ).not.toBeInTheDocument();
  });

  it("routes review controls to the shared review sidebar and omits commit", () => {
    const onReview = vi.fn();
    const onToggleRightSidebar = vi.fn();

    render(
      <TopNavBar
        onReview={onReview}
        onToggleRightSidebar={onToggleRightSidebar}
        isRightSidebarOpen={false}
        isAuthenticated
        environmentSummary={environmentSummary}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(onReview).toHaveBeenCalledTimes(1);

    fireEvent.click(
      screen.getByRole("button", { name: "Toggle right sidebar" }),
    );
    expect(onToggleRightSidebar).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Toggle summary" }),
    ).toBeInTheDocument();

    expect(screen.queryByText("Commit")).not.toBeInTheDocument();
    expect(screen.queryByText("Review")).not.toBeInTheDocument();
  });

  it("reserves header space for the integrated sidebar tabs", () => {
    render(
      <TopNavBar
        onReview={vi.fn()}
        isRightSidebarOpen
        rightSidebarWidth={520}
        isAuthenticated
        environmentSummary={environmentSummary}
      />,
    );

    expect(screen.getByRole("button", { name: "Open" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Toggle summary" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Review" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Toggle right sidebar" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("top-nav-actions")).toHaveStyle({
      marginRight: "520px",
    });
  });

  it("passes environment summary probe gating through to the summary control", () => {
    render(
      <TopNavBar
        isAuthenticated
        environmentSummary={{ ...environmentSummary, enabled: false }}
      />,
    );

    expect(screen.getByRole("button", { name: "Toggle summary" })).toHaveAttribute(
      "data-enabled",
      "false",
    );
  });
});
