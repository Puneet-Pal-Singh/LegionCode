import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PendingWorkflowSurface } from "./PendingWorkflowSurface.js";

describe("PendingWorkflowSurface", () => {
  it("acknowledges submission without inventing canonical activity", () => {
    render(
      <PendingWorkflowSurface />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Thinking");
    expect(screen.queryByText(/working for/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/tool/i)).not.toBeInTheDocument();
  });
});
