import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitReviewProvider, useGitReview } from "./GitReviewContext";
import type { ReviewCommentAnchor } from "./reviewComments";

const mockRefetch = vi.hoisted(() => vi.fn(async () => undefined));
const mockFetchDiff = vi.hoisted(() => vi.fn(async () => undefined));
const mockCommit = vi.hoisted(() => vi.fn(async () => true));

vi.mock("../../hooks/useRunContext", () => ({
  useRunContext: () => ({
    runId: "run-1",
    sessionId: "session-1",
  }),
}));

vi.mock("../../hooks/useGitStatus", () => ({
  useGitStatus: () => ({
    status: null,
    gitAvailable: true,
    loading: false,
    error: null,
    refetch: mockRefetch,
  }),
}));

vi.mock("../../hooks/useGitDiff", () => ({
  useGitDiff: () => ({
    diff: null,
    loading: false,
    error: null,
    fetch: mockFetchDiff,
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
    mockFetchDiff.mockClear();
    mockCommit.mockClear();
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
