import type {
  FileStatus,
  PromptArtifactReviewSource,
} from "@repo/shared-types";

export type ReviewSourceKind = "live_git" | "saved_edit";
export type ReviewRequestedScope = "git-changes" | "prompt-artifact";

export type ReviewSourceSelection =
  | {
      kind: "live_git";
      reason: "explicit" | "live_git_has_changes" | "empty";
    }
  | {
      kind: "saved_edit";
      artifactId: string;
      assistantMessageId?: string;
      reason: "explicit" | "chat_artifact" | "live_git_empty_fallback";
    };

export interface OpenedReviewArtifact {
  artifactId: string;
  assistantMessageId?: string;
}

interface ResolveReviewSourceInput {
  requestedScope: ReviewRequestedScope | null;
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
      kind: "saved_edit",
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
      kind: "saved_edit",
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
  reason: Extract<ReviewSourceSelection, { kind: "saved_edit" }>["reason"],
): ReviewSourceSelection {
  return {
    kind: "saved_edit",
    artifactId: source.artifactId,
    assistantMessageId: source.assistantMessageId,
    reason,
  };
}
