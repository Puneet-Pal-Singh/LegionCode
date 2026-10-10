export type ReviewSourceKind = "live_git" | "prompt_artifact" | "turn_diff";
export type ReviewScope = "git-changes" | "prompt-artifact" | "turn-diff";

export const REVIEW_SOURCE_LABELS: Record<
  ReviewSourceKind,
  { scope: string; badge: string }
> = {
  live_git: {
    scope: "Git changes",
    badge: "Git changes",
  },
  prompt_artifact: {
    scope: "Last turn changes",
    badge: "Last turn",
  },
  turn_diff: {
    scope: "Last turn changes",
    badge: "Last turn",
  },
};
