import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GitHubSignInPage } from "./GitHubSignInPage";

describe("GitHubSignInPage", () => {
  it("presents one GitHub-first authentication action", () => {
    const onLogin = vi.fn();
    render(<GitHubSignInPage onLogin={onLogin} />);

    expect(
      screen.getByRole("heading", {
        name: "Give an agent a repository. Review the result.",
      }),
    ).toBeInTheDocument();
    const action = screen.getByRole("button", { name: "Continue with GitHub" });
    fireEvent.click(action);
    expect(onLogin).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});
