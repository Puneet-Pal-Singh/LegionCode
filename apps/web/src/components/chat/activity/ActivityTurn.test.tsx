import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActivityTurn } from "./ActivityTurn.js";

describe("ActivityTurn", () => {
  it("renders a completed duration header without an empty expansion control", () => {
    render(
      <ActivityTurn
        turn={{
          key: "turn-1",
          userPrompt: "hello",
          elapsedLabel: "Worked for 6s",
          summaryLabel: "Workflow captured",
          defaultCollapsed: true,
          isActiveTurn: false,
          hasVisibleRows: true,
          rows: [],
        }}
        expanded={false}
        onToggleTurn={vi.fn()}
        expandedRows={{}}
        onToggleRow={vi.fn()}
      />,
    );

    expect(screen.getByText("Worked for 6s")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Worked for 6s" }),
    ).not.toBeInTheDocument();
  });
});
