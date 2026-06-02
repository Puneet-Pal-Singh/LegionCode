import type {
  FileStatus,
  PromptArtifactReviewSource,
} from "@repo/shared-types";

export type ReviewSourceKind = "live_git" | "prompt_artifact";
export type ReviewScope = "git-changes" | "prompt-artifact";

export const REVIEW_SOURCE_LABELS: Record<
  ReviewSourceKind,
  { scope: string; badge: string }
> = {
  live_git: {
    scope: "Live Git changes",
    badge: "Live Git",
  },
  prompt_artifact: {
    scope: "Saved edit",
    badge: "Saved edit",
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
      /** Tracks whether a saved edit was explicitly requested, opened from chat, or selected as fallback. */
      reason: "explicit" | "chat_artifact" | "live_git_empty_fallback";
    };

export interface OpenedReviewArtifact {
  artifactId: string;
  assistantMessageId?: string;
}

interface ResolveReviewSourceInput {
  requestedScope: ReviewScope | null;
  openedArtifact: OpenedReviewArtifact | null;
  liveGitFiles: FileStatus[];
  latestArtifactSource: PromptArtifactReviewSource | null;
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

  if (input.openedArtifact) {
    return {
      kind: "prompt_artifact",
      artifactId: input.openedArtifact.artifactId,
      assistantMessageId: input.openedArtifact.assistantMessageId,
      reason: "chat_artifact",
    };
  }

  if (input.liveGitFiles.length > 0) {
    return { kind: "live_git", reason: "live_git_has_changes" };
  }

  if (hasArtifactFiles(input.latestArtifactSource)) {
    return toSavedEditSelection(
      input.latestArtifactSource,
      "live_git_empty_fallback",
    );
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
      reason: "explicit",
    };
  }

  if (input.latestArtifactSource) {
    return toSavedEditSelection(input.latestArtifactSource, "explicit");
  }

  return { kind: "live_git", reason: "empty" };
}

function hasArtifactFiles(
  source: PromptArtifactReviewSource | null,
): source is PromptArtifactReviewSource {
  return Boolean(source && source.files.length > 0);
}

function toSavedEditSelection(
  source: PromptArtifactReviewSource,
  reason: Extract<ReviewSourceSelection, { kind: "prompt_artifact" }>["reason"],
): ReviewSourceSelection {
  return {
    kind: "prompt_artifact",
    artifactId: source.artifactId,
    assistantMessageId: source.assistantMessageId,
    reason,
  };
}
