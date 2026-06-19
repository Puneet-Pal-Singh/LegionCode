import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReviewDiffToolbar } from "./ReviewDiffToolbar";

describe("ReviewDiffToolbar", () => {
  it("toggles file changes directly and keeps collapse in the options menu", () => {
    const onToggleAllDiffs = vi.fn();
    const onToggleChanges = vi.fn();
    const onReviewChanges = vi.fn();
    const onToggleFiles = vi.fn();
    render(
      <ReviewDiffToolbar
        reviewScope="prompt-artifact"
        onReviewScopeChange={vi.fn()}
        layout="stacked"
        onLayoutChange={vi.fn()}
        wordWrap
        onWordWrapChange={vi.fn()}
        allDiffsCollapsed={false}
        onToggleAllDiffs={onToggleAllDiffs}
        isChangesOpen={false}
        onToggleChanges={onToggleChanges}
        branch="main"
        reviewCommentCount={1}
        onReviewChanges={onReviewChanges}
        isFilesOpen={false}
        onToggleFiles={onToggleFiles}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Collapse All Diffs" }),
    ).not.toBeInTheDocument();
    expect(
      screen
        .getByRole("button", { name: "Diff view options" })
        .closest(".overflow-visible"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Diff view options" }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Collapse All Diffs" }),
    );
    expect(onToggleAllDiffs).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Last turn changes" }));
    expect(
      screen.getByRole("menuitem", { name: "Git changes" }),
    ).toBeInTheDocument();

    expect(
      screen.queryByRole("menuitem", { name: "File changes" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Toggle file changes sidebar" }),
    );
    expect(onToggleChanges).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Toggle files sidebar" }),
    );
    expect(onToggleFiles).toHaveBeenCalledTimes(1);
    expect(
      screen
        .getByRole("button", { name: "Toggle files sidebar" })
        .querySelector(".lucide-folders"),
    ).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review changes (1)" }));
    expect(onReviewChanges).toHaveBeenCalledTimes(1);
  });
});
