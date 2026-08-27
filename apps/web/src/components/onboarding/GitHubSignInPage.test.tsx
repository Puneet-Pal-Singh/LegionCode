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
    expect(screen.getByRole("img", { name: "LegionCode" })).toBeInTheDocument();
    expect(screen.queryByText("LC")).not.toBeInTheDocument();
    const action = screen.getByRole("button", { name: "Continue with GitHub" });
    fireEvent.click(action);
    expect(onLogin).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByText(/by continuing/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/private alpha/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/repositories LegionCode/i),
    ).not.toBeInTheDocument();
  });
});
