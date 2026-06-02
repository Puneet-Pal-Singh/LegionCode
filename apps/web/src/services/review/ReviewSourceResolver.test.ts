import { describe, expect, it } from "vitest";
import type {
  FileStatus,
  PromptArtifactReviewSource,
} from "@repo/shared-types";
import { resolveReviewSource } from "./ReviewSourceResolver";

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
      kind: "saved_edit",
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
      kind: "saved_edit",
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
      kind: "saved_edit",
      artifactId: "artifact-chat",
      assistantMessageId: "assistant-chat",
      reason: "chat_artifact",
    });
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
    createdAt: "2026-06-02T00:00:00.000Z",
    storageBackend: "r2_postgres",
  };
}
