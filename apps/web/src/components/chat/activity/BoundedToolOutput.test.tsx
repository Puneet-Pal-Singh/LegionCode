import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BoundedToolOutput } from "./BoundedToolOutput.js";

describe("BoundedToolOutput", () => {
  it("previews long output and expands it explicitly", () => {
    const tailMarker = "terminal-tail-marker";
    render(
      <BoundedToolOutput
        output={`${"x".repeat(4_100)}${tailMarker}`}
        sourceTruncated={true}
      />,
    );

    expect(screen.queryByText(new RegExp(tailMarker))).not.toBeInTheDocument();
    expect(
      screen.getByText("The runtime retained a bounded output tail."),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Expand output" }));
    expect(screen.getByText(new RegExp(tailMarker))).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show less" }),
    ).toBeInTheDocument();
  });
});
