import { useCallback, useMemo, useState } from "react";
import type { DiffContent } from "@repo/shared-types";
import {
  rebindReviewCommentDraft,
  type CreateReviewCommentInput,
  type ReviewCommentDraft,
} from "./reviewComments";

interface UseReviewCommentsStateInput {
  runId: string | null;
  sessionId: string | null;
  selectedFilePath: string | null;
  diff: DiffContent | null;
  currentDiffFingerprint: string | null;
}

export function useReviewCommentsState({
  runId,
  sessionId,
  selectedFilePath,
  diff,
  currentDiffFingerprint,
}: UseReviewCommentsStateInput) {
  const [reviewComments, setReviewComments] = useState<ReviewCommentDraft[]>(
    [],
  );
  const effectiveReviewComments = useMemo(
    () =>
      reviewComments.map((comment) => {
        if (
          !selectedFilePath ||
          !diff ||
          !currentDiffFingerprint ||
          comment.filePath !== selectedFilePath ||
          comment.diffFingerprint === currentDiffFingerprint
        ) {
          return comment;
        }

        return rebindReviewCommentDraft(comment, diff, currentDiffFingerprint);
      }),
    [currentDiffFingerprint, diff, reviewComments, selectedFilePath],
  );
  const selectedReviewComments = useMemo(
    () =>
      effectiveReviewComments.filter(
        (comment) => comment.selected && !comment.stale,
      ),
    [effectiveReviewComments],
  );
  const selectedReviewCommentsForFile = useMemo(() => {
    if (!selectedFilePath) {
      return [];
    }

    return effectiveReviewComments.filter(
      (comment) => comment.filePath === selectedFilePath,
    );
  }, [effectiveReviewComments, selectedFilePath]);
  const addReviewComment = useCallback(
    (input: CreateReviewCommentInput): void => {
      if (!runId || !sessionId) {
        return;
      }

      setReviewComments((previous) => [
        {
          id: crypto.randomUUID(),
          filePath: input.filePath,
          line: input.line,
          side: input.side,
          note: input.note,
          createdAt: new Date().toISOString(),
          linePreview: input.linePreview,
          selected: true,
          anchors: input.anchors,
          primaryAnchor: input.primaryAnchor,
          selectionMode: input.selectionMode,
          runId,
          sessionId,
          diffFingerprint: input.diffFingerprint,
          stale: false,
          deliveryState: "draft",
        },
        ...previous,
      ]);
    },
    [runId, sessionId],
  );
  const deleteReviewComment = useCallback((commentId: string): void => {
    setReviewComments((previous) =>
      previous.filter((comment) => comment.id !== commentId),
    );
  }, []);
  const toggleReviewCommentSelected = useCallback(
    (commentId: string, nextSelected: boolean): void => {
      setReviewComments((previous) =>
        previous.map((comment) =>
          comment.id === commentId ? { ...comment, selected: nextSelected } : comment,
        ),
      );
    },
    [],
  );
  const updateReviewCommentDeliveryState = useCallback(
    (
      commentIds: string[],
      deliveryState: ReviewCommentDraft["deliveryState"],
      nextSelected: boolean,
    ): void => {
      if (commentIds.length === 0) {
        return;
      }

      const commentIdSet = new Set(commentIds);
      setReviewComments((previous) =>
        previous.map((comment) =>
          commentIdSet.has(comment.id)
            ? { ...comment, deliveryState, selected: nextSelected }
            : comment,
        ),
      );
    },
    [],
  );
  const markReviewCommentsDispatching = useCallback(
    (commentIds: string[]): void => {
      updateReviewCommentDeliveryState(commentIds, "dispatching", false);
    },
    [updateReviewCommentDeliveryState],
  );
  const markReviewCommentsDispatched = useCallback(
    (commentIds: string[]): void => {
      updateReviewCommentDeliveryState(commentIds, "dispatched", false);
    },
    [updateReviewCommentDeliveryState],
  );
  const markReviewCommentsDispatchFailed = useCallback(
    (commentIds: string[], options?: { reselect: boolean }): void => {
      updateReviewCommentDeliveryState(
        commentIds,
        "dispatch_failed",
        options?.reselect ?? false,
      );
    },
    [updateReviewCommentDeliveryState],
  );

  return {
    reviewComments: effectiveReviewComments,
    selectedReviewComments,
    selectedReviewCommentCount: selectedReviewComments.length,
    selectedReviewCommentsForFile,
    addReviewComment,
    deleteReviewComment,
    toggleReviewCommentSelected,
    markReviewCommentsDispatching,
    markReviewCommentsDispatched,
    markReviewCommentsDispatchFailed,
  };
}
