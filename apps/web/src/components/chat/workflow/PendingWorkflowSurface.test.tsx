import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PendingWorkflowSurface } from "./PendingWorkflowSurface.js";

describe("PendingWorkflowSurface", () => {
  it("acknowledges submission without inventing canonical activity", () => {
    vi.setSystemTime(new Date("2026-07-29T12:00:02.000Z"));

    render(
      <PendingWorkflowSurface
        startedAt={Date.parse("2026-07-29T12:00:00.000Z")}
      />,
    );

    expect(screen.getByText("Working for 2s")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Thinking");
    expect(screen.queryByText(/tool/i)).not.toBeInTheDocument();
  });
});
