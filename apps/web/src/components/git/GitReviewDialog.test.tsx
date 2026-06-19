import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitReviewDialog } from "./GitReviewDialog";

const reviewMock = vi.hoisted(() => ({
  isReviewOpen: true,
  closeReview: vi.fn(),
  status: { branch: "feat/review-shell" },
  selectedFile: { path: "src/example.ts" },
  reviewFiles: [],
  selectedReviewCommentCount: 1,
  selectFile: vi.fn(),
}));

vi.mock("./useGitReview", () => ({
  useGitReview: () => reviewMock,
}));

vi.mock("../sidebar/ChangesPanel", () => ({
  ChangesPanel: ({
    branch,
    reviewCommentCount,
    onReviewChanges,
    isChangesOpen,
    onToggleChanges,
  }: {
    branch?: string;
    reviewCommentCount?: number;
    onReviewChanges?: () => void;
    isChangesOpen?: boolean;
    onToggleChanges?: () => void;
  }) => (
    <div
      data-testid="changes-panel"
      data-branch={branch}
      data-changes-open={String(isChangesOpen)}
    >
      <button type="button" onClick={onReviewChanges}>
        Review changes ({reviewCommentCount})
      </button>
      <button type="button" onClick={onToggleChanges}>
        Toggle file changes sidebar
      </button>
    </div>
  ),
}));

describe("GitReviewDialog", () => {
  beforeEach(() => {
    reviewMock.closeReview.mockClear();
  });

  it("renders a full review workspace and delegates its toolbar context", () => {
    const onOpenFiles = vi.fn();
    render(<GitReviewDialog onOpenFiles={onOpenFiles} />);

    expect(screen.getByRole("dialog")).toHaveClass(
      "h-[92vh]",
      "w-[94vw]",
      "max-w-[1600px]",
    );
    expect(screen.getByRole("tab", { name: "Review" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("changes-panel")).toHaveAttribute(
      "data-branch",
      "feat/review-shell",
    );

    fireEvent.click(screen.getByRole("button", { name: "Review changes (1)" }));
    expect(reviewMock.closeReview).toHaveBeenCalledTimes(1);

    fireEvent.click(
      screen.getByRole("button", { name: "Toggle file changes sidebar" }),
    );
    expect(screen.getByTestId("changes-panel")).toHaveAttribute(
      "data-changes-open",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "View files" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "View files" }));
    expect(onOpenFiles).toHaveBeenCalledTimes(1);
  });
});
