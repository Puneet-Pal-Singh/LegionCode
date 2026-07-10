import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebErrorBoundary } from "./WebErrorBoundary";

const reportWebException = vi.hoisted(() => vi.fn());

vi.mock("../../lib/web-error-reporter", () => ({ reportWebException }));

function ThrowingChild(): never {
  throw new Error("render failed");
}

describe("WebErrorBoundary", () => {
  afterEach(() => {
    reportWebException.mockReset();
    vi.restoreAllMocks();
  });

  it("renders a recovery screen and reports a render failure", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <WebErrorBoundary>
        <ThrowingChild />
      </WebErrorBoundary>,
    );

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(reportWebException).toHaveBeenCalledWith(
      "ui.render.failed",
      expect.any(Error),
      expect.objectContaining({ componentStack: expect.any(String) }),
    );
  });
});
