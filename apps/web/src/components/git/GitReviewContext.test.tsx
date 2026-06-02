import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitReviewProvider, useGitReview } from "./GitReviewContext";
import type { ReviewCommentAnchor } from "./reviewComments";
import type {
  FileStatus,
  GitStatusResponse,
  PromptArtifactReviewSource,
} from "@repo/shared-types";

const mockRefetch = vi.hoisted(() => vi.fn(async () => undefined));
const mockFetchLiveDiff = vi.hoisted(() => vi.fn(async () => undefined));
const mockFetchArtifactDiff = vi.hoisted(() => vi.fn(async () => undefined));
const mockCommit = vi.hoisted(() => vi.fn(async () => true));
const mockGitStatusState = vi.hoisted(() => ({
  status: null as GitStatusResponse | null,
  loading: false,
  error: null as string | null,
}));
const mockArtifactState = vi.hoisted(() => ({
  source: null as PromptArtifactReviewSource | null,
  loading: false,
  error: null as string | null,
}));

vi.mock("../../hooks/useRunContext", () => ({
  useRunContext: () => ({
    runId: "run-1",
    sessionId: "session-1",
  }),
}));

vi.mock("../../hooks/useGitStatus", () => ({
  useGitStatus: () => ({
    status: mockGitStatusState.status,
    gitAvailable: true,
    loading: mockGitStatusState.loading,
    error: mockGitStatusState.error,
    refetch: mockRefetch,
  }),
}));

vi.mock("../../hooks/useGitDiff", () => ({
  useGitDiff: () => ({
    diff: null,
    loading: false,
    error: null,
    fetch: mockFetchLiveDiff,
  }),
}));

vi.mock("../../hooks/useEditArtifactReviewSource", () => ({
  useEditArtifactReviewSource: () => ({
    source: mockArtifactState.source,
    loading: mockArtifactState.loading,
    error: mockArtifactState.error,
    refetch: vi.fn(async () => undefined),
  }),
}));

vi.mock("../../hooks/useEditArtifactDiff", () => ({
  useEditArtifactDiff: () => ({
    diff: null,
    loading: false,
    error: null,
    fetch: mockFetchArtifactDiff,
  }),
}));

vi.mock("../../hooks/useGitCommit", () => ({
  useGitCommit: () => ({
    committing: false,
    error: null,
    errorState: null,
    commit: mockCommit,
  }),
}));

vi.mock("../../lib/git-client.js", () => ({
  createGitBranch: vi.fn(async () => ({ branch: "feature/test" })),
  pushGitBranch: vi.fn(async () => ({ branch: "feature/test" })),
  stageGitFiles: vi.fn(async () => undefined),
}));

describe("GitReviewProvider", () => {
  beforeEach(() => {
    mockRefetch.mockClear();
    mockFetchLiveDiff.mockClear();
    mockFetchArtifactDiff.mockClear();
    mockCommit.mockClear();
    mockGitStatusState.status = null;
    mockGitStatusState.loading = false;
    mockGitStatusState.error = null;
    mockArtifactState.source = null;
    mockArtifactState.loading = false;
    mockArtifactState.error = null;
    vi.stubGlobal("crypto", {
      randomUUID: () => "comment-1",
    });
  });

  it("removes sent review comments from the composer while dispatching", () => {
    render(
      <GitReviewProvider isReviewOpen={false} onReviewOpenChange={vi.fn()}>
        <ReviewCommentSelectionProbe />
      </GitReviewProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "add comment" }));

    expect(screen.getByTestId("selected-count")).toHaveTextContent("1");
    expect(screen.getByTestId("delivery-state")).toHaveTextContent("draft");

    fireEvent.click(screen.getByRole("button", { name: "dispatch comment" }));

    expect(screen.getByTestId("selected-count")).toHaveTextContent("0");
    expect(screen.getByTestId("delivery-state")).toHaveTextContent(
      "dispatching",
    );

    fireEvent.click(screen.getByRole("button", { name: "fail dispatch" }));

    expect(screen.getByTestId("selected-count")).toHaveTextContent("1");
    expect(screen.getByTestId("delivery-state")).toHaveTextContent(
      "dispatch_failed",
    );
  });

  it("uses saved edit files when live git status is empty", () => {
    mockGitStatusState.status = buildGitStatus([]);
    mockArtifactState.source = buildArtifactSource();

    render(
      <GitReviewProvider isReviewOpen={false} onReviewOpenChange={vi.fn()}>
        <ReviewSourceProbe />
      </GitReviewProvider>,
    );

    expect(screen.getByTestId("review-scope")).toHaveTextContent(
      "prompt-artifact",
    );
    expect(screen.getByTestId("review-source")).toHaveTextContent(
      "saved_edit:live_git_empty_fallback",
    );
    expect(screen.getByTestId("review-files")).toHaveTextContent("src/main.ts");

    fireEvent.click(screen.getByRole("button", { name: "select first file" }));

    expect(mockFetchArtifactDiff).toHaveBeenCalledWith("src/main.ts");
    expect(mockFetchLiveDiff).not.toHaveBeenCalled();
  });

  it("keeps explicit live git selection even when a saved edit exists", () => {
    mockGitStatusState.status = buildGitStatus([]);
    mockArtifactState.source = buildArtifactSource();

    render(
      <GitReviewProvider isReviewOpen={false} onReviewOpenChange={vi.fn()}>
        <ReviewSourceProbe />
      </GitReviewProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "select live git" }));

    expect(screen.getByTestId("review-scope")).toHaveTextContent("git-changes");
    expect(screen.getByTestId("review-source")).toHaveTextContent(
      "live_git:explicit",
    );
    expect(screen.getByTestId("review-files")).toHaveTextContent("none");
  });
});

function ReviewCommentSelectionProbe() {
  const review = useGitReview();
  const comment = review.reviewComments[0];
  const selectedIds = review.selectedReviewComments.map((item) => item.id);
  const commentIds = review.reviewComments.map((item) => item.id);

  return (
    <div>
      <span data-testid="selected-count">
        {review.selectedReviewCommentCount}
      </span>
      <span data-testid="delivery-state">
        {comment?.deliveryState ?? "none"}
      </span>
      <button type="button" onClick={() => review.addReviewComment(buildInput())}>
        add comment
      </button>
      <button
        type="button"
        onClick={() => review.markReviewCommentsDispatching(selectedIds)}
      >
        dispatch comment
      </button>
      <button
        type="button"
        onClick={() =>
          review.markReviewCommentsDispatchFailed(commentIds, {
            reselect: true,
          })
        }
      >
        fail dispatch
      </button>
    </div>
  );
}

function ReviewSourceProbe() {
  const review = useGitReview();
  const firstFile = review.reviewFiles[0];

  return (
    <div>
      <span data-testid="review-scope">{review.reviewScope}</span>
      <span data-testid="review-source">
        {review.reviewSource.kind}:{review.reviewSource.reason}
      </span>
      <span data-testid="review-files">
        {review.reviewFiles.map((file) => file.path).join(",") || "none"}
      </span>
      <button
        type="button"
        onClick={() => {
          if (firstFile) {
            review.selectFile(firstFile);
          }
        }}
      >
        select first file
      </button>
      <button type="button" onClick={() => review.setReviewScope("git-changes")}>
        select live git
      </button>
    </div>
  );
}

function buildInput() {
  const anchor: ReviewCommentAnchor = {
    hunkIndex: 0,
    lineIndex: 0,
    rowKey: "0:0",
    newLineNumber: 183,
    side: "right",
    linePreview: "<div",
  };

  return {
    filePath: "src/components/layout/Footer.tsx",
    line: 183,
    side: "right" as const,
    note: "So these are logos?",
    linePreview: "<div",
    anchors: [anchor],
    primaryAnchor: anchor,
    selectionMode: "single" as const,
    diffFingerprint: "fingerprint-1",
  };
}

function buildGitStatus(files: FileStatus[]): GitStatusResponse {
  return {
    branch: "main",
    files,
    ahead: 0,
    behind: 0,
    hasStaged: files.some((file) => file.isStaged),
    hasUnstaged: files.some((file) => !file.isStaged),
    gitAvailable: true,
  };
}

function buildArtifactSource(): PromptArtifactReviewSource {
  return {
    kind: "prompt_artifact",
    artifactId: "artifact-1",
    runId: "run-1",
    sessionId: "session-1",
    workspaceId: "workspace-1",
    assistantMessageId: "assistant-1",
    status: "stored",
    files: [
      {
        path: "src/main.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        diffAvailable: true,
      },
    ],
    createdAt: "2026-06-02T00:00:00.000Z",
    storageBackend: "r2_postgres",
  };
}
