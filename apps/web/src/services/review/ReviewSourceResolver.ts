import type {
  DiffContent,
  EditArtifactIdentity,
  FileStatus,
  PromptArtifactReviewSource,
} from "@repo/shared-types";

export interface CanonicalTurnReviewSource {
  readonly turnId: string;
  readonly files: FileStatus[];
  readonly loadFileDiff: (file: FileStatus) => Promise<DiffContent>;
  readonly error: string | null;
}

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

export type ReviewSourceSelection =
  | {
      kind: "live_git";
      /** Tracks whether live Git was explicitly requested, has files, or is the honest empty result. */
      reason: "explicit" | "live_git_has_changes" | "empty";
    }
  | {
      kind: "prompt_artifact";
      artifactId: string;
      assistantMessageId?: string;
      identity?: EditArtifactIdentity;
      /** Tracks whether a saved edit was explicitly requested or opened from chat. */
      reason: "explicit" | "chat_artifact";
    }
  | {
      kind: "turn_diff";
      turnId: string;
      reason: "canonical_terminal";
    };

export interface OpenedReviewArtifact {
  artifactId: string;
  assistantMessageId?: string;
  identity?: EditArtifactIdentity;
}

interface ResolveReviewSourceInput {
  requestedScope: ReviewScope | null;
  openedArtifact: OpenedReviewArtifact | null;
  liveGitFiles: FileStatus[];
  latestArtifactSource: PromptArtifactReviewSource | null;
  canonicalTurnReview?: CanonicalTurnReviewSource | null;
}

export function resolveReviewSource(
  input: ResolveReviewSourceInput,
): ReviewSourceSelection {
  if (input.requestedScope === "git-changes") {
    return { kind: "live_git", reason: "explicit" };
  }

  if (input.requestedScope === "prompt-artifact") {
    return resolveExplicitSavedEdit(input);
  }

  if (input.canonicalTurnReview) {
    return {
      kind: "turn_diff",
      turnId: input.canonicalTurnReview.turnId,
      reason: "canonical_terminal",
    };
  }

  if (input.openedArtifact) {
    return {
      kind: "prompt_artifact",
      artifactId: input.openedArtifact.artifactId,
      assistantMessageId: input.openedArtifact.assistantMessageId,
      identity: input.openedArtifact.identity,
      reason: "chat_artifact",
    };
  }

  if (input.liveGitFiles.length > 0) {
    return { kind: "live_git", reason: "live_git_has_changes" };
  }

  return { kind: "live_git", reason: "empty" };
}

function resolveExplicitSavedEdit(
  input: ResolveReviewSourceInput,
): ReviewSourceSelection {
  if (input.openedArtifact) {
    return {
      kind: "prompt_artifact",
      artifactId: input.openedArtifact.artifactId,
      assistantMessageId: input.openedArtifact.assistantMessageId,
      identity: input.openedArtifact.identity,
      reason: "explicit",
    };
  }

  if (input.latestArtifactSource) {
    return toSavedEditSelection(input.latestArtifactSource, "explicit");
  }

  return { kind: "live_git", reason: "empty" };
}

function toSavedEditSelection(
  source: PromptArtifactReviewSource,
  reason: Extract<ReviewSourceSelection, { kind: "prompt_artifact" }>["reason"],
): ReviewSourceSelection {
  return {
    kind: "prompt_artifact",
    artifactId: source.artifactId,
    assistantMessageId: source.assistantMessageId,
    identity: {
      threadId: source.threadId,
      turnId: source.turnId,
      runAttemptId: source.runAttemptId,
      workspaceId: source.workspaceId,
    },
    reason,
  };
}
