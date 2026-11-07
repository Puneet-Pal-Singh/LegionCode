import {
  CommitTurnArtifactRequestSchema,
  CommitTurnArtifactResponseSchema,
  type CommitTurnArtifactRequest,
  type CommitTurnArtifactResponse,
} from "@repo/platform-protocol";
import { GitServiceError } from "@repo/git-service/errors";
import { LocalGitOperationError, type LocalGitService } from "./local-git.js";
import type { LocalTurnArtifactReads } from "./local-turn-artifact-reads.js";
import { AppServerOperationError } from "./server.js";

/** Scope translation only. The existing read owner authorizes the saved source;
 * the injected Git owner still verifies publication, grant and mutation safety.
 * Trusted composition must leave this service absent while mutations are blocked.
 */
export class LocalTurnArtifactCommitService {
  constructor(
    private readonly options: {
      readonly reads: Pick<LocalTurnArtifactReads, "getTurnDiffArtifact">;
      readonly git: Pick<LocalGitService, "commit">;
    },
  ) {}

  async commitTurnArtifact(
    input: CommitTurnArtifactRequest,
  ): Promise<CommitTurnArtifactResponse> {
    const request = CommitTurnArtifactRequestSchema.parse(input);
    const source = await this.options.reads.getTurnDiffArtifact({
      turnId: request.turnId,
    });
    if (!source) {
      throw new AppServerOperationError(
        409,
        "conflict",
        "The selected turn has no published immutable diff",
        "artifact_unavailable",
        false,
      );
    }
    if (
      source.admission.turn.id !== request.turnId ||
      source.diff.turnId !== request.turnId
    ) {
      throw new AppServerOperationError(
        503,
        "server_unavailable",
        "Saved turn artifact identity could not be verified",
        "identity_mismatch",
        false,
      );
    }
    // The shared read just reauthorized this exact admission. No asynchronous
    // work intervenes before the Git owner's own grant/publication checks.
    try {
      const committed = await this.options.git.commit({
        workspaceId: source.admission.run.workspaceId,
        threadId: source.admission.run.threadId,
        runId: source.admission.run.id,
        turnId: source.admission.turn.id,
        runAttemptId: source.admission.runAttemptId,
        artifactId: source.artifactId,
        message: request.message,
        author: request.author,
      });
      // A grant change after an irreversible commit must not discard its actual
      // receipt. This adapter never manufactures a terminal event or retries Git.
      const result = CommitTurnArtifactResponseSchema.safeParse({
        turnId: request.turnId,
        artifactId: source.artifactId,
        commitSha: committed.commitSha,
        branchName: committed.branchName,
      });
      if (!result.success) throw indeterminate();
      return result.data;
    } catch (error) {
      throw transportFailure(error);
    }
  }
}

function transportFailure(error: unknown): AppServerOperationError {
  if (error instanceof LocalGitOperationError) {
    const messages: Record<LocalGitOperationError["code"], string> = {
      workspace_unavailable: "The workspace grant is unavailable",
      artifact_unavailable: "The saved artifact is unavailable",
      identity_mismatch: "Saved artifact identity could not be verified",
      artifact_conflict: "The saved artifact conflicts with the repository",
      commit_identity_required: "A commit author is required",
    };
    const invalid = error.code === "commit_identity_required";
    const unavailable = error.code === "identity_mismatch";
    return new AppServerOperationError(
      invalid ? 400 : unavailable ? 503 : 409,
      invalid
        ? "invalid_request"
        : unavailable
          ? "server_unavailable"
          : "conflict",
      messages[error.code],
      error.code,
      false,
    );
  }
  if (error instanceof GitServiceError) {
    if (error.code === "git_commit_indeterminate") return indeterminate();
    const conflict = ["git_artifact_conflict"].includes(error.code);
    const invalid = ["invalid_branch_ref", "invalid_git_input"].includes(
      error.code,
    );
    return new AppServerOperationError(
      conflict ? 409 : invalid ? 400 : 503,
      conflict
        ? "conflict"
        : invalid
          ? "invalid_request"
          : "server_unavailable",
      "The saved artifact commit could not be completed",
      error.code,
      false,
    );
  }
  // The commit owner was invoked. An untyped exception is not proof that HEAD
  // stayed unchanged, including failures while reading or validating its receipt.
  return indeterminate();
}

function indeterminate(): AppServerOperationError {
  return new AppServerOperationError(
    503,
    "server_unavailable",
    "Saved artifact commit outcome is unknown; do not retry automatically",
    "git_commit_indeterminate",
    false,
  );
}
