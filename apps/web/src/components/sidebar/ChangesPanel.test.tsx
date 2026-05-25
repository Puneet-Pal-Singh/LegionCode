import { describe, expect, it, beforeEach, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChangesPanel } from "./ChangesPanel";

const mockSelectFile = vi.hoisted(() => vi.fn());
const mockSetReviewScope = vi.hoisted(() => vi.fn());
const mockOpenReview = vi.hoisted(() => vi.fn());
const mockGitReviewState = vi.hoisted(() => ({
  hasStatus: true,
  gitAvailable: true,
  statusLoading: false,
  isGitWorkspaceRecovering: false,
  statusError: null as string | null,
}));
const mockStatusFiles = vi.hoisted(() => [
  {
    path: "src/main.ts",
    status: "modified" as const,
    isStaged: false,
    additions: 1,
    deletions: 0,
  },
]);

function buildChangedFile() {
  return {
    path: "src/main.ts",
    status: "modified" as const,
    isStaged: false,
    additions: 1,
    deletions: 0,
  };
}

vi.mock("../git/GitReviewContext", () => ({
  useGitReview: () => ({
    status: mockGitReviewState.hasStatus
      ? {
          branch: "main",
          files: mockStatusFiles,
        }
      : null,
    gitAvailable: mockGitReviewState.gitAvailable,
    statusLoading: mockGitReviewState.statusLoading,
    isGitWorkspaceRecovering: mockGitReviewState.isGitWorkspaceRecovering,
    statusError: mockGitReviewState.statusError,
    diff: null,
    diffLoading: false,
    diffError: null,
    stageError: null,
    commitError: null,
    committing: false,
    selectedFile: null,
    stagedFiles: new Set<string>(),
    commitMessage: "feat: ship it",
    reviewScope: "git-changes",
    setReviewScope: mockSetReviewScope,
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
    setCommitMessage: vi.fn(),
    openReview: mockOpenReview,
    closeReview: vi.fn(),
    selectFile: mockSelectFile,
    toggleFileStaged: vi.fn(),
    stageAll: vi.fn(),
    unstageAll: vi.fn(),
    submitCommit: vi.fn(),
    refetch: vi.fn(),
  }),
}));

vi.mock("../diff/ChangesList", () => ({
  ChangesList: ({
    onSelectFile,
    reviewScope,
    onReviewScopeChange,
  }: {
    onSelectFile: (file: {
      path: string;
      status: "modified";
      isStaged: boolean;
      additions: number;
      deletions: number;
    }) => void;
    reviewScope: "git-changes";
    onReviewScopeChange: (scope: "git-changes") => void;
  }) => (
    <div>
      <div data-testid="review-scope">{reviewScope}</div>
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
        data-testid="set-scope"
        onClick={() => onReviewScopeChange("git-changes")}
      >
        set scope
      </button>
    </div>
  ),
}));

vi.mock("../diff/DiffViewer", () => ({
  DiffViewer: () => <div>diff-viewer</div>,
}));

describe("ChangesPanel", () => {
  beforeEach(() => {
    mockStatusFiles.splice(0, mockStatusFiles.length, buildChangedFile());
    mockGitReviewState.hasStatus = true;
    mockGitReviewState.gitAvailable = true;
    mockGitReviewState.statusLoading = false;
    mockGitReviewState.isGitWorkspaceRecovering = false;
    mockGitReviewState.statusError = null;
    mockSelectFile.mockClear();
    mockSetReviewScope.mockClear();
    mockOpenReview.mockClear();
  });

  it("selects a file from the sidebar without opening the modal review dialog", () => {
    const onFileSelect = vi.fn();
    render(<ChangesPanel onFileSelect={onFileSelect} />);

    fireEvent.click(screen.getByTestId("select-file"));

    expect(mockSelectFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: "src/main.ts" }),
    );
    expect(onFileSelect).toHaveBeenCalledWith("src/main.ts");
    expect(mockOpenReview).not.toHaveBeenCalled();
  });

  it("delegates file selection to the shared git review state in modal mode", () => {
    const onFileSelect = vi.fn();
    render(<ChangesPanel mode="modal" onFileSelect={onFileSelect} />);

    fireEvent.click(screen.getByTestId("select-file"));

    expect(mockSelectFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: "src/main.ts" }),
    );
    expect(onFileSelect).toHaveBeenCalledWith("src/main.ts");
    expect(mockOpenReview).not.toHaveBeenCalled();
  });

  it("passes the shared review scope state to the changes list", () => {
    render(<ChangesPanel />);

    expect(screen.getByTestId("review-scope")).toHaveTextContent("git-changes");

    fireEvent.click(screen.getByTestId("set-scope"));

    expect(mockSetReviewScope).toHaveBeenCalledWith("git-changes");
  });

  it("selects the first changed file when the stacked modal hides the file tree", () => {
    render(<ChangesPanel mode="modal" layout="stacked" />);

    expect(screen.queryByTestId("select-file")).not.toBeInTheDocument();
    expect(screen.getByText("Loading diff...")).toBeInTheDocument();
    expect(mockSelectFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: "src/main.ts" }),
    );
  });

  it("shows no changes in the stacked modal when there are no changed files", () => {
    mockStatusFiles.splice(0, mockStatusFiles.length);

    render(<ChangesPanel mode="modal" layout="stacked" />);

    expect(screen.getByText("No changes")).toBeInTheDocument();
    expect(mockSelectFile).not.toHaveBeenCalled();
  });

  it("shows a recovery state while git availability is being refreshed", () => {
    mockGitReviewState.gitAvailable = false;
    mockGitReviewState.isGitWorkspaceRecovering = true;
    mockGitReviewState.statusError = "Git service is temporarily unavailable.";
    mockGitReviewState.hasStatus = false;

    render(<ChangesPanel />);

    expect(
      screen.getByText("Recovering workspace after restart..."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Git service is temporarily unavailable/),
    ).toBeNull();
    expect(
      screen.queryByText(/Git is not available for this workspace yet/),
    ).not.toBeInTheDocument();
  });
});
