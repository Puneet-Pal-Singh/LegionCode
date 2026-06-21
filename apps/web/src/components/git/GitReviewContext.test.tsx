import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitReviewProvider } from "./GitReviewContext";
import { useGitReview } from "./useGitReview";
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
const mockGitStatusInputs = vi.hoisted(
  () =>
    [] as Array<{
      runId?: string;
      sessionId?: string;
      enabled?: boolean;
    }>,
);
const mockArtifactState = vi.hoisted(() => ({
  source: null as PromptArtifactReviewSource | null,
  loading: false,
  error: null as string | null,
  resolved: false,
}));
const mockArtifactHookInputs = vi.hoisted(
  () =>
    [] as Array<{
      runId?: string;
      sessionId?: string;
      assistantMessageId?: string;
      enabled: boolean;
    }>,
);

vi.mock("../../hooks/useRunContext", () => ({
  useRunContext: () => ({
    runId: "run-1",
    sessionId: "session-1",
  }),
}));

vi.mock("../../hooks/useGitStatus", () => ({
  useGitStatus: (runId?: string, sessionId?: string, enabled?: boolean) => {
    mockGitStatusInputs.push({ runId, sessionId, enabled });
    return {
      status: enabled === false ? null : mockGitStatusState.status,
      gitAvailable: true,
      loading: enabled === false ? false : mockGitStatusState.loading,
      error: enabled === false ? null : mockGitStatusState.error,
      refetch: mockRefetch,
    };
  },
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
  useEditArtifactReviewSource: (input: {
    runId?: string;
    sessionId?: string;
    assistantMessageId?: string;
    enabled: boolean;
  }) => {
    mockArtifactHookInputs.push(input);
    return {
      source: mockArtifactState.source,
      loading: mockArtifactState.loading,
      error: mockArtifactState.error,
      resolved: mockArtifactState.resolved,
      refetch: vi.fn(async () => undefined),
    };
  },
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
    mockArtifactState.resolved = false;
    mockGitStatusInputs.splice(0, mockGitStatusInputs.length);
    mockArtifactHookInputs.splice(0, mockArtifactHookInputs.length);
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

  it("uses saved edit files when live git status is empty", async () => {
    mockGitStatusState.status = buildGitStatus([]);
    mockArtifactState.source = buildArtifactSource();

    const view = render(
      <GitReviewProvider isReviewOpen onReviewOpenChange={vi.fn()}>
        <ReviewSourceProbe />
      </GitReviewProvider>,
    );

    expect(screen.getByTestId("review-scope")).toHaveTextContent(
      "prompt-artifact",
    );
    expect(screen.getByTestId("review-source")).toHaveTextContent(
      "prompt_artifact:live_git_empty_fallback",
    );
    expect(screen.getByTestId("review-files")).toHaveTextContent("src/main.ts");

    await waitFor(() => {
      expect(mockFetchArtifactDiff).toHaveBeenCalledWith("src/main.ts");
    });
    view.rerender(
      <GitReviewProvider isReviewOpen onReviewOpenChange={vi.fn()}>
        <ReviewSourceProbe />
      </GitReviewProvider>,
    );

    expect(mockFetchArtifactDiff).toHaveBeenCalledTimes(1);
    expect(mockFetchLiveDiff).not.toHaveBeenCalled();
  });

  it("refetches the saved edit diff after switching scopes away and back", async () => {
    mockGitStatusState.status = buildGitStatus([]);
    mockArtifactState.source = buildArtifactSource();

    render(
      <GitReviewProvider isReviewOpen onReviewOpenChange={vi.fn()}>
        <ReviewSourceProbe />
      </GitReviewProvider>,
    );

    await waitFor(() => {
      expect(mockFetchArtifactDiff).toHaveBeenCalledWith("src/main.ts");
    });
    mockFetchArtifactDiff.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "select live git" }));
    fireEvent.click(screen.getByRole("button", { name: "select saved edit" }));

    await waitFor(() => {
      expect(mockFetchArtifactDiff).toHaveBeenCalledWith("src/main.ts");
    });
  });

  it("fetches the first live diff when review files arrive", async () => {
    mockGitStatusState.status = buildGitStatus([
      buildFileStatus("src/live.ts"),
    ]);

    render(
      <GitReviewProvider isReviewOpen onReviewOpenChange={vi.fn()}>
        <ReviewSourceProbe />
      </GitReviewProvider>,
    );

    await waitFor(() => {
      expect(mockFetchLiveDiff).toHaveBeenCalledWith("src/live.ts", false);
    });
  });

  it("keeps explicit live git selection even when a saved edit exists", () => {
    mockGitStatusState.status = buildGitStatus([]);
    mockArtifactState.source = buildArtifactSource();

    render(
      <GitReviewProvider isReviewOpen onReviewOpenChange={vi.fn()}>
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

  it("loads review sources while the sidebar review surface is active", () => {
    mockGitStatusState.status = buildGitStatus([]);
    mockArtifactState.source = buildArtifactSource();
    mockArtifactState.resolved = true;

    render(
      <GitReviewProvider
        isReviewOpen={false}
        isReviewActive
        onReviewOpenChange={vi.fn()}
      >
        <ReviewSourceProbe />
      </GitReviewProvider>,
    );

    expect(latestGitStatusHookInput()).toEqual(
      expect.objectContaining({ enabled: true }),
    );
    expect(latestArtifactHookInput()).toEqual(
      expect.objectContaining({ enabled: true }),
    );
    expect(screen.getByTestId("review-files")).toHaveTextContent("src/main.ts");
  });

  it("loads an explicit saved edit selection even when live git has files", () => {
    mockGitStatusState.status = buildGitStatus([
      buildFileStatus("src/live.ts"),
    ]);
    mockArtifactState.source = buildArtifactSource();
    mockArtifactState.resolved = true;

    render(
      <GitReviewProvider isReviewOpen onReviewOpenChange={vi.fn()}>
        <ReviewSourceProbe />
      </GitReviewProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "select saved edit" }));

    expect(latestArtifactHookInput()).toEqual(
      expect.objectContaining({ enabled: true }),
    );
    expect(screen.getByTestId("review-scope")).toHaveTextContent(
      "prompt-artifact",
    );
    expect(screen.getByTestId("review-files")).toHaveTextContent("src/main.ts");
  });

  it("starts saved edit lookup before live git status resolves empty", () => {
    mockGitStatusState.status = null;
    mockGitStatusState.loading = true;
    mockArtifactState.loading = false;
    mockArtifactState.resolved = false;

    render(
      <GitReviewProvider isReviewOpen onReviewOpenChange={vi.fn()}>
        <ReviewSourceProbe />
      </GitReviewProvider>,
    );

    expect(latestArtifactHookInput()).toEqual(
      expect.objectContaining({ enabled: true }),
    );
    expect(screen.getByTestId("review-source-loading")).toHaveTextContent(
      "loading",
    );
  });

  it("pins chat-opened artifacts even when live git has files", () => {
    mockGitStatusState.status = buildGitStatus([
      buildFileStatus("src/live.ts"),
    ]);
    mockArtifactState.source = buildArtifactSource();
    mockArtifactState.resolved = true;

    render(
      <GitReviewProvider isReviewOpen onReviewOpenChange={vi.fn()}>
        <ReviewSourceProbe />
      </GitReviewProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "open chat artifact" }));

    expect(screen.getByTestId("review-scope")).toHaveTextContent(
      "prompt-artifact",
    );
    expect(screen.getByTestId("review-source")).toHaveTextContent(
      "prompt_artifact:explicit",
    );
    expect(latestArtifactHookInput()).toEqual(
      expect.objectContaining({
        assistantMessageId: "assistant-chat",
        enabled: true,
      }),
    );
  });

  it("preserves every changed file in a multi-file live review", () => {
    mockGitStatusState.status = buildGitStatus([
      buildFileStatus("src/first.ts"),
      buildFileStatus("src/second.ts"),
      buildFileStatus("src/third.ts"),
    ]);

    render(
      <GitReviewProvider isReviewOpen onReviewOpenChange={vi.fn()}>
        <ReviewSourceProbe />
      </GitReviewProvider>,
    );

    expect(screen.getByTestId("review-scope")).toHaveTextContent("git-changes");
    expect(screen.getByTestId("review-files")).toHaveTextContent(
      "src/first.ts,src/second.ts,src/third.ts",
    );
  });

  it("does not load git status or saved edit artifacts while review is closed", () => {
    mockGitStatusState.status = buildGitStatus([]);

    render(
      <GitReviewProvider isReviewOpen={false} onReviewOpenChange={vi.fn()}>
        <ReviewSourceProbe />
      </GitReviewProvider>,
    );

    expect(latestGitStatusHookInput()).toEqual(
      expect.objectContaining({ enabled: false }),
    );
    expect(latestArtifactHookInput()).toEqual(
      expect.objectContaining({ enabled: false }),
    );
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
      <button
        type="button"
        onClick={() => review.addReviewComment(buildInput())}
      >
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
      <span data-testid="review-source-loading">
        {review.reviewSourceLoading ? "loading" : "idle"}
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
      <button
        type="button"
        onClick={() => review.setReviewScope("git-changes")}
      >
        select live git
      </button>
      <button
        type="button"
        onClick={() => review.setReviewScope("prompt-artifact")}
      >
        select saved edit
      </button>
      <button
        type="button"
        onClick={() =>
          review.openPromptArtifactReview("artifact-chat", "assistant-chat")
        }
      >
        open chat artifact
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

function latestArtifactHookInput() {
  return mockArtifactHookInputs[mockArtifactHookInputs.length - 1];
}

function latestGitStatusHookInput() {
  return mockGitStatusInputs[mockGitStatusInputs.length - 1];
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

function buildFileStatus(path: string): FileStatus {
  return {
    path,
    status: "modified",
    additions: 1,
    deletions: 0,
    isStaged: false,
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
