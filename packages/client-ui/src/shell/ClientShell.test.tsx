// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ClientErrorBoundary } from "./ClientErrorBoundary.js";
import { ClientShellLoading } from "./ClientShellLoading.js";

function ThrowingChild(): never {
  throw new Error("render failed");
}

describe("shared client shell states", () => {
  it("exposes an accessible loading status", () => {
    render(<ClientShellLoading label="Checking session" />);

    expect(
      screen.getByRole("status", { name: "Checking session" }),
    ).toBeInTheDocument();
  });

  it("reports render failures and shows the recovery surface", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onError = vi.fn();

    render(
      <ClientErrorBoundary onError={onError}>
        <ThrowingChild />
      </ClientErrorBoundary>,
    );

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ source: "render", error: expect.any(Error) }),
    );
  });
});
