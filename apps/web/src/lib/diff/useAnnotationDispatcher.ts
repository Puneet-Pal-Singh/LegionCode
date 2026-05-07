import { useMemo } from "react";
import type { DiffContent } from "@repo/shared-types";
import type {
  CreateReviewCommentInput,
  ReviewCommentAnchor,
  ReviewCommentDraft,
  ReviewCommentSelectionMode,
  ReviewCommentSide,
} from "../../components/git/reviewComments";

interface AnnotationDispatcherInput {
  diff: DiffContent;
  reviewComments: ReviewCommentDraft[];
  diffFingerprint?: string | null;
  onCreateReviewComment?: (input: CreateReviewCommentInput) => void;
  onDeleteReviewComment?: (commentId: string) => void;
  selectedRowKeys: string[];
  lineLookup: Map<string, ReviewCommentAnchor>;
  clearSelection: () => void;
}

export interface AnnotationDispatcherState {
  canCreateReviewComment: boolean;
  annotationCounts: Map<string, number>;
  annotationsByAnchor: Map<string, ReviewCommentDraft[]>;
  addAnnotation: (note: string) => void;
  resolveAnnotation: (annotationId: string) => void;
}

export function useAnnotationDispatcher({
  diff,
  reviewComments,
  diffFingerprint = null,
  onCreateReviewComment,
  onDeleteReviewComment,
  selectedRowKeys,
  lineLookup,
  clearSelection,
}: AnnotationDispatcherInput): AnnotationDispatcherState {
  const canCreateReviewComment = Boolean(diffFingerprint && onCreateReviewComment);

  const annotationCounts = useMemo(() => {
    const counts = new Map<string, number>();
    reviewComments.forEach((annotation) => {
      annotation.anchors.forEach((anchor) => {
        const rowKey = anchor.rowKey;
        counts.set(rowKey, (counts.get(rowKey) ?? 0) + 1);
      });
    });
    return counts;
  }, [reviewComments]);

  const annotationsByAnchor = useMemo(() => {
    const anchored = new Map<string, ReviewCommentDraft[]>();
    reviewComments.forEach((annotation) => {
      const anchorKey = annotation.primaryAnchor.rowKey;
      if (!anchorKey) {
        return;
      }
      const existing = anchored.get(anchorKey) ?? [];
      existing.push(annotation);
      anchored.set(anchorKey, existing);
    });
    return anchored;
  }, [reviewComments]);

  const addAnnotation = (note: string) => {
    const trimmedNote = note.trim();
    if (
      !trimmedNote ||
      selectedRowKeys.length === 0 ||
      !canCreateReviewComment ||
      !diffFingerprint ||
      !onCreateReviewComment
    ) {
      return;
    }

    const anchors = selectedRowKeys
      .map((rowKey) => lineLookup.get(rowKey))
      .filter((anchor): anchor is ReviewCommentAnchor => anchor !== undefined);
    const primaryAnchor = anchors[anchors.length - 1];
    if (!primaryAnchor) {
      return;
    }

    const selectionMode: ReviewCommentSelectionMode =
      anchors.length > 1 ? "range" : "single";
    onCreateReviewComment({
      filePath: diff.newPath || diff.oldPath,
      line: primaryAnchor.newLineNumber ?? primaryAnchor.oldLineNumber ?? 0,
      side: normalizePrimarySide(primaryAnchor.side),
      note: trimmedNote,
      linePreview: primaryAnchor.linePreview,
      anchors,
      primaryAnchor,
      selectionMode,
      diffFingerprint,
    });
    clearSelection();
  };

  const resolveAnnotation = (annotationId: string) => {
    onDeleteReviewComment?.(annotationId);
  };

  return {
    canCreateReviewComment,
    annotationCounts,
    annotationsByAnchor,
    addAnnotation,
    resolveAnnotation,
  };
}

function normalizePrimarySide(side: ReviewCommentSide): ReviewCommentSide {
  if (side === "both") {
    return "right";
  }
  return side;
}
