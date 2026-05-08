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

describe("TopNavBar", () => {
  it("routes review controls to the shared review sidebar and omits commit", () => {
    const onReview = vi.fn();
    const onToggleRightSidebar = vi.fn();

    render(
      <TopNavBar
        onReview={onReview}
        onToggleRightSidebar={onToggleRightSidebar}
        isRightSidebarOpen={false}
        isAuthenticated
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(onReview).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Toggle right sidebar" }));
    expect(onToggleRightSidebar).toHaveBeenCalledTimes(1);

    expect(screen.queryByText("Commit")).not.toBeInTheDocument();
    expect(screen.queryByText("Review")).not.toBeInTheDocument();
  });

  it("keeps the first-header review control icon-only when the right sidebar is open", () => {
    render(
      <TopNavBar
        onReview={vi.fn()}
        isRightSidebarOpen
        isAuthenticated
      />,
    );

    expect(screen.getByRole("button", { name: "Open" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review" })).toHaveClass(
      "bg-zinc-800",
    );
    expect(screen.queryByText("Review")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Toggle right sidebar" }),
    ).toBeInTheDocument();
  });
});
