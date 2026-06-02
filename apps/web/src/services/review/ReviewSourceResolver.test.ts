import { describe, expect, it } from "vitest";
import type {
  FileStatus,
  PromptArtifactReviewSource,
} from "@repo/shared-types";
import { resolveReviewSource } from "./ReviewSourceResolver";

const TEST_CREATED_AT = "2026-01-01T00:00:00.000Z";

describe("resolveReviewSource", () => {
  it("uses live git when live files are present", () => {
    const source = resolveReviewSource({
      requestedScope: null,
      openedArtifact: null,
      liveGitFiles: [buildFileStatus("src/main.ts")],
      latestArtifactSource: buildArtifactSource(),
    });

    expect(source).toEqual({
      kind: "live_git",
      reason: "live_git_has_changes",
    });
  });

  it("uses saved edit when live git is empty and an artifact has files", () => {
    const source = resolveReviewSource({
      requestedScope: null,
      openedArtifact: null,
      liveGitFiles: [],
      latestArtifactSource: buildArtifactSource(),
    });

    expect(source).toEqual({
      kind: "prompt_artifact",
      artifactId: "artifact-1",
      assistantMessageId: "assistant-1",
      reason: "live_git_empty_fallback",
    });
  });

  it("preserves explicit live git selection", () => {
    const source = resolveReviewSource({
      requestedScope: "git-changes",
      openedArtifact: null,
      liveGitFiles: [],
      latestArtifactSource: buildArtifactSource(),
    });

    expect(source).toEqual({ kind: "live_git", reason: "explicit" });
  });

  it("preserves explicit saved edit selection", () => {
    const source = resolveReviewSource({
      requestedScope: "prompt-artifact",
      openedArtifact: null,
      liveGitFiles: [buildFileStatus("src/main.ts")],
      latestArtifactSource: buildArtifactSource(),
    });

    expect(source).toEqual({
      kind: "prompt_artifact",
      artifactId: "artifact-1",
      assistantMessageId: "assistant-1",
      reason: "explicit",
    });
  });

  it("pins an opened chat artifact", () => {
    const source = resolveReviewSource({
      requestedScope: null,
      openedArtifact: {
        artifactId: "artifact-chat",
        assistantMessageId: "assistant-chat",
      },
      liveGitFiles: [buildFileStatus("src/main.ts")],
      latestArtifactSource: buildArtifactSource(),
    });

    expect(source).toEqual({
      kind: "prompt_artifact",
      artifactId: "artifact-chat",
      assistantMessageId: "assistant-chat",
      reason: "chat_artifact",
    });
  });

  it("returns empty live git when saved edit is requested without an artifact", () => {
    const source = resolveReviewSource({
      requestedScope: "prompt-artifact",
      openedArtifact: null,
      liveGitFiles: [],
      latestArtifactSource: null,
    });

    expect(source).toEqual({ kind: "live_git", reason: "empty" });
  });

  it("returns empty live git when all inputs are empty", () => {
    const source = resolveReviewSource({
      requestedScope: null,
      openedArtifact: null,
      liveGitFiles: [],
      latestArtifactSource: null,
    });

    expect(source).toEqual({ kind: "live_git", reason: "empty" });
  });

  it("respects explicit live git scope even when an artifact is opened", () => {
    const source = resolveReviewSource({
      requestedScope: "git-changes",
      openedArtifact: {
        artifactId: "artifact-chat",
        assistantMessageId: "assistant-chat",
      },
      liveGitFiles: [],
      latestArtifactSource: buildArtifactSource(),
    });

    expect(source).toEqual({ kind: "live_git", reason: "explicit" });
  });
});

function buildFileStatus(path: string): FileStatus {
  return {
    path,
    status: "modified",
    additions: 1,
    deletions: 0,
    isStaged: false,
  };
}

function buildArtifactSource(): PromptArtifactReviewSource {
  return {
    kind: "prompt_artifact",
    artifactId: "artifact-1",
    runId: "run-1",
    sessionId: "session-1",
    workspaceId: "workspace-1",
    assistantMessageId: "assistant-1",
    status: "stored",
    files: [
      {
        path: "src/main.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        diffAvailable: true,
      },
    ],
    createdAt: TEST_CREATED_AT,
    storageBackend: "r2_postgres",
  };
}
