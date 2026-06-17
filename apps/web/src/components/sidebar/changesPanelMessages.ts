import type { FileStatus } from "@repo/shared-types";
import type { ReviewScope } from "../../services/review/ReviewSourceResolver";

export function getEmptyReviewLabel({
  isSavedEditMode,
  reviewScope,
  reviewSourceReason,
  reviewSourceLoading,
  reviewSourceError,
}: {
  isSavedEditMode: boolean;
  reviewScope: ReviewScope;
  reviewSourceReason: string;
  reviewSourceLoading: boolean;
  reviewSourceError: string | null;
}): string {
  if (isSavedEditMode || reviewScope === "prompt-artifact") {
    return reviewSourceLoading
      ? "Loading last turn..."
      : (reviewSourceError ?? "No saved changes for the last turn");
  }

  if (reviewSourceReason === "explicit") {
    return "No Git changes";
  }

  if (reviewSourceLoading) {
    return "Checking last-turn changes...";
  }

  return "No reviewed changes yet";
}

export function getDiffMessage({
  selectedFile,
  diffLoading,
  diffError,
  hasFiles,
  emptyReviewLabel,
}: {
  selectedFile: FileStatus | null;
  diffLoading: boolean;
  diffError: string | null;
  hasFiles: boolean;
  emptyReviewLabel: string;
}): string {
  if (selectedFile) {
    return diffLoading ? "Loading diff..." : (diffError ?? "No diff available");
  }

  return hasFiles ? "Loading diff..." : emptyReviewLabel;
}
