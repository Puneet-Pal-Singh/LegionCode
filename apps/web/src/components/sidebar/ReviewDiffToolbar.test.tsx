import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReviewDiffToolbar } from "./ReviewDiffToolbar";

describe("ReviewDiffToolbar", () => {
  it("toggles file changes directly and keeps collapse in the options menu", () => {
    const onToggleHunks = vi.fn();
    const onToggleChanges = vi.fn();
    render(
      <ReviewDiffToolbar
        reviewScope="prompt-artifact"
        onReviewScopeChange={vi.fn()}
        layout="stacked"
        onLayoutChange={vi.fn()}
        wordWrap
        onWordWrapChange={vi.fn()}
        hunksCollapsed={false}
        onToggleHunks={onToggleHunks}
        isChangesOpen={false}
        onToggleChanges={onToggleChanges}
      />,
    );

    expect(screen.queryByRole("button", { name: "Collapse all" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Diff view options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Collapse all" }));
    expect(onToggleHunks).toHaveBeenCalledTimes(1);

    expect(screen.queryByRole("menuitem", { name: "File changes" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Toggle file changes sidebar" }));
    expect(onToggleChanges).toHaveBeenCalledTimes(1);
  });
});
