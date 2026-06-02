import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AuthShellLoading } from "./AuthShellLoading";

describe("AuthShellLoading", () => {
  it("renders a neutral session-checking shell state", () => {
    render(<AuthShellLoading />);

    expect(
      screen.getByRole("status", { name: "Checking session" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Checking session")).toBeInTheDocument();
  });
});
