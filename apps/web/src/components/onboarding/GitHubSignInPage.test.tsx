import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GitHubSignInPage } from "./GitHubSignInPage";

describe("GitHubSignInPage", () => {
  it("presents one GitHub-first authentication action", () => {
    const onLogin = vi.fn();
    render(<GitHubSignInPage onLogin={onLogin} />);

    expect(
      screen.getByRole("heading", {
        name: "Sign in to LegionCode",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Brainstorm in Chat. Build in Cloud."),
    ).toBeInTheDocument();
    const action = screen.getByRole("button", { name: "Continue with GitHub" });
    fireEvent.click(action);
    expect(onLogin).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Terms" })).toHaveAttribute(
      "href",
      "/terms",
    );
    expect(
      screen.getByRole("link", { name: "Privacy Policy" }),
    ).toHaveAttribute("href", "/privacy");
    expect(screen.queryByText(/private alpha/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/repositories LegionCode/i)).not.toBeInTheDocument();
  });
});
