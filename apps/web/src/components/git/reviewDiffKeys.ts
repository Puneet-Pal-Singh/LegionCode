import type { ReviewSourceSelection } from "../../services/review/ReviewSourceResolver";

export function buildReviewDiffSourceKey({
  reviewSource,
  artifactId,
}: {
  reviewSource: ReviewSourceSelection;
  artifactId?: string;
}): string {
  if (reviewSource.kind === "prompt_artifact") {
    return artifactId ?? "pending-artifact";
  }
  if (reviewSource.kind === "turn_diff") {
    return `turn-diff:${reviewSource.turnId}`;
  }
  return "live-git";
}

export function buildAutoFetchDiffKey({
  sourceKey,
  path,
  staged,
}: {
  sourceKey: string;
  path: string | null;
  staged: boolean;
}): string | null {
  return path ? `${sourceKey}:${path}:${staged ? "staged" : "unstaged"}` : null;
}
