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
  selectedFile: null as {
    path: string;
    status: "modified";
    isStaged: boolean;
    additions: number;
    deletions: number;
  } | null,
  diff: null as {
    oldPath: string;
    newPath: string;
    hunks: unknown[];
    isBinary: boolean;
    isNewFile: boolean;
    isDeleted: boolean;
  } | null,
  reviewSourceLoading: false,
  reviewScope: "git-changes" as "git-changes" | "prompt-artifact",
  reviewSourceReason: "live_git_has_changes" as
    | "live_git_has_changes"
    | "empty"
    | "explicit",
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
    diff: mockGitReviewState.diff,
    diffLoading: false,
    diffError: null,
    stageError: null,
    commitError: null,
    committing: false,
    selectedFile: mockGitReviewState.selectedFile,
    reviewFiles: mockStatusFiles,
    stagedFiles: new Set<string>(),
    commitMessage: "feat: ship it",
    reviewScope: mockGitReviewState.reviewScope,
    setReviewScope: mockSetReviewScope,
    reviewSource: {
      kind: "live_git",
      reason:
        mockStatusFiles.length === 0
          ? mockGitReviewState.reviewSourceReason === "explicit"
            ? "explicit"
            : "empty"
          : "live_git_has_changes",
    },
    reviewSourceLoading: mockGitReviewState.reviewSourceLoading,
    reviewSourceError: null,
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
    openPromptArtifactReview: vi.fn(),
    openLiveGitReview: vi.fn(),
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
    reviewScope: "git-changes" | "prompt-artifact";
    onReviewScopeChange: (scope: "git-changes" | "prompt-artifact") => void;
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
    mockGitReviewState.selectedFile = null;
    mockGitReviewState.diff = null;
    mockGitReviewState.reviewSourceLoading = false;
    mockGitReviewState.reviewScope = "git-changes";
    mockGitReviewState.reviewSourceReason = "live_git_has_changes";
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

  it("renders the selected diff in sidebar mode", () => {
    mockGitReviewState.selectedFile = buildChangedFile();
    mockGitReviewState.diff = {
      oldPath: "src/main.ts",
      newPath: "src/main.ts",
      hunks: [],
      isBinary: false,
      isNewFile: false,
      isDeleted: false,
    };

    render(<ChangesPanel />);

    expect(screen.getByText("diff-viewer")).toBeInTheDocument();
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

    expect(screen.getByText("No reviewed changes yet")).toBeInTheDocument();
    expect(mockSelectFile).not.toHaveBeenCalled();
  });

  it("shows saved edit lookup while fallback source is still loading", () => {
    mockStatusFiles.splice(0, mockStatusFiles.length);
    mockGitReviewState.reviewSourceLoading = true;

    render(<ChangesPanel mode="modal" layout="stacked" />);

    expect(screen.getByText("Checking last-turn changes...")).toBeInTheDocument();
    expect(screen.queryByText("No reviewed changes yet")).toBeNull();
  });

  it("shows live git empty state for explicit live git selection", () => {
    mockStatusFiles.splice(0, mockStatusFiles.length);
    mockGitReviewState.reviewSourceLoading = true;
    mockGitReviewState.reviewSourceReason = "explicit";

    render(<ChangesPanel mode="modal" layout="stacked" />);

    expect(screen.getByText("No Git changes")).toBeInTheDocument();
    expect(screen.queryByText("Checking last-turn changes...")).toBeNull();
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
