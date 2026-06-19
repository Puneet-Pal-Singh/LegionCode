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
    isFilesOpen,
    onToggleFiles,
    filesRail,
  }: {
    branch?: string;
    reviewCommentCount?: number;
    onReviewChanges?: () => void;
    isChangesOpen?: boolean;
    onToggleChanges?: () => void;
    isFilesOpen?: boolean;
    onToggleFiles?: () => void;
    filesRail?: React.ReactNode;
  }) => (
    <div
      data-testid="changes-panel"
      data-branch={branch}
      data-changes-open={String(isChangesOpen)}
      data-files-open={String(isFilesOpen)}
    >
      <button type="button" onClick={onReviewChanges}>
        Review changes ({reviewCommentCount})
      </button>
      <button type="button" onClick={onToggleChanges}>
        Toggle file changes sidebar
      </button>
      <button type="button" onClick={onToggleFiles}>
        Toggle files sidebar
      </button>
      {isFilesOpen ? filesRail : null}
    </div>
  ),
}));

describe("GitReviewDialog", () => {
  beforeEach(() => {
    reviewMock.closeReview.mockClear();
  });

  it("renders a full review workspace and delegates its toolbar context", () => {
    render(
      <GitReviewDialog
        contentTabs={[
          {
            id: "file:src/example.ts",
            kind: "file",
            path: "src/example.ts",
            content: "export const example = true;",
          },
        ]}
        renderFilesRail={(onFileOpened) => (
          <button type="button" onClick={() => onFileOpened("src/example.ts")}>
            Open example file
          </button>
        )}
      />,
    );

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

    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Files" }));
    expect(
      screen.getByRole("button", { name: "Open example file" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("changes-panel")).not.toBeInTheDocument();
    expect(screen.getByText("Open file")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open example file" }));
    expect(screen.getByRole("tab", { name: "example.ts" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(document.querySelector("code")?.textContent).toContain(
      "export const example = true;",
    );

    fireEvent.click(screen.getByRole("tab", { name: "Review" }));
    expect(screen.getByRole("tab", { name: "Review" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});
