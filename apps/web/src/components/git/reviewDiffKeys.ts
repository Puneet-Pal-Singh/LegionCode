import type { ReviewSourceSelection } from "../../services/review/ReviewSourceResolver";

export function buildReviewDiffSourceKey({
  reviewSource,
  artifactId,
}: {
  reviewSource: ReviewSourceSelection;
  artifactId?: string;
}): string {
  return reviewSource.kind === "prompt_artifact"
    ? (artifactId ?? "pending-artifact")
    : "live-git";
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
