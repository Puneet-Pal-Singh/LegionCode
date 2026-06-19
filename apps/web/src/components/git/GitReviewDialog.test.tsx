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
  }: {
    branch?: string;
    reviewCommentCount?: number;
    onReviewChanges?: () => void;
  }) => (
    <div data-testid="changes-panel" data-branch={branch}>
      <button type="button" onClick={onReviewChanges}>
        Review changes ({reviewCommentCount})
      </button>
    </div>
  ),
}));

describe("GitReviewDialog", () => {
  beforeEach(() => {
    reviewMock.closeReview.mockClear();
  });

  it("renders a full review workspace and delegates its toolbar context", () => {
    render(<GitReviewDialog />);

    expect(screen.getByRole("dialog")).toHaveClass(
      "h-[calc(100vh-2rem)]",
      "w-[calc(100vw-2rem)]",
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
  });
});
