import { describe, expect, it, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChangesPanel } from "./ChangesPanel";

const mockSelectFile = vi.hoisted(() => vi.fn());
const mockToggleFileStaged = vi.hoisted(() => vi.fn(async () => {}));
const mockStageAll = vi.hoisted(() => vi.fn(async () => {}));
const mockUnstageAll = vi.hoisted(() => vi.fn(async () => {}));
const mockSubmitCommit = vi.hoisted(() => vi.fn(async () => true));
const mockSetCommitMessage = vi.hoisted(() => vi.fn());
const mockOpenReview = vi.hoisted(() => vi.fn());

vi.mock("../git/GitReviewContext", () => ({
  useGitReview: () => ({
    status: {
      branch: "main",
      files: [
        {
          path: "src/main.ts",
          status: "modified",
          isStaged: false,
          additions: 1,
          deletions: 0,
        },
      ],
    },
    gitAvailable: true,
    statusLoading: false,
    statusError: null,
    diff: null,
    diffLoading: false,
    diffError: null,
    stageError: null,
    commitError: null,
    committing: false,
    selectedFile: null,
    stagedFiles: new Set<string>(),
    commitMessage: "feat: ship it",
    reviewComments: [],
    selectedReviewComments: [],
    selectedReviewCommentCount: 0,
    selectedReviewCommentsForFile: [],
    currentDiffFingerprint: null,
    addReviewComment: vi.fn(),
    deleteReviewComment: vi.fn(),
    toggleReviewCommentSelected: vi.fn(),
    markReviewCommentsDispatching: vi.fn(),
    markReviewCommentsDispatched: vi.fn(),
    markReviewCommentsDispatchFailed: vi.fn(),
    setCommitMessage: mockSetCommitMessage,
    openReview: mockOpenReview,
    closeReview: vi.fn(),
    selectFile: mockSelectFile,
    toggleFileStaged: mockToggleFileStaged,
    stageAll: mockStageAll,
    unstageAll: mockUnstageAll,
    submitCommit: mockSubmitCommit,
    refetch: vi.fn(),
  }),
}));

vi.mock("../diff/ChangesList", () => ({
  ChangesList: ({
    onToggleStaged,
    onStageAll,
    onUnstageAll,
    onSelectFile,
  }: {
    onToggleStaged: (path: string, staged: boolean) => void;
    onStageAll: () => void;
    onUnstageAll: () => void;
    onSelectFile: (file: {
      path: string;
      status: "modified";
      isStaged: boolean;
      additions: number;
      deletions: number;
    }) => void;
  }) => (
    <div>
      <button
        type="button"
        data-testid="select-file"
        onClick={() =>
          onSelectFile({
            path: "src/main.ts",
            status: "modified",
            isStaged: false,
            additions: 1,
            deletions: 0,
          })
        }
      >
        select
      </button>
      <button
        type="button"
        data-testid="stage-file"
        onClick={() => onToggleStaged("src/main.ts", true)}
      >
        stage
      </button>
      <button type="button" data-testid="stage-all" onClick={onStageAll}>
        stage all
      </button>
      <button type="button" data-testid="unstage-all" onClick={onUnstageAll}>
        unstage all
      </button>
    </div>
  ),
}));

vi.mock("../diff/DiffViewer", () => ({
  DiffViewer: () => <div>diff-viewer</div>,
}));

describe("ChangesPanel", () => {
  beforeEach(() => {
    mockSelectFile.mockClear();
    mockToggleFileStaged.mockClear();
    mockStageAll.mockClear();
    mockUnstageAll.mockClear();
    mockSubmitCommit.mockClear();
    mockSetCommitMessage.mockClear();
    mockOpenReview.mockClear();
  });

  it("opens the shared review dialog when selecting a file from the sidebar", async () => {
    render(<ChangesPanel />);

    fireEvent.click(screen.getByTestId("select-file"));

    expect(mockOpenReview).toHaveBeenCalledWith("src/main.ts");
    expect(mockSelectFile).not.toHaveBeenCalled();
  });

  it("delegates file selection and staging actions to the shared git review state in modal mode", async () => {
    render(<ChangesPanel mode="modal" />);

    fireEvent.click(screen.getByTestId("select-file"));
    fireEvent.click(screen.getByTestId("stage-file"));
    fireEvent.click(screen.getByTestId("stage-all"));
    fireEvent.click(screen.getByTestId("unstage-all"));

    expect(mockSelectFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: "src/main.ts" }),
    );
    expect(mockOpenReview).not.toHaveBeenCalled();
    expect(mockToggleFileStaged).toHaveBeenCalledWith("src/main.ts", true);
    expect(mockStageAll).toHaveBeenCalledTimes(1);
    expect(mockUnstageAll).toHaveBeenCalledTimes(1);
  });

  it("uses the shared commit action", async () => {
    render(<ChangesPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Commit" }));

    await waitFor(() => {
      expect(mockSubmitCommit).toHaveBeenCalledTimes(1);
    });
  });
});
