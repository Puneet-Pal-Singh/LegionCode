import type {
  DiffContent,
  EditArtifactRecord,
  EditArtifactReviewFile,
  EditArtifactDiffResponse,
  PromptArtifactReviewSource,
} from "@repo/shared-types";
import type { ArtifactRepository } from "@repo/persistence";
import type { Env } from "../../types/ai";
import { withArtifactRepository } from "./ArtifactPersistenceFactory";
import { createEditArtifactStorageBackend } from "./EditArtifactStorageBackendFactory";
import { sha256Hex } from "./EditArtifactStorageBackend";
import {
  EditArtifactPatchParseError,
  parsePatchFileDiff,
  parsePatchFileInventory,
} from "./EditArtifactPatchParser";

export type EditArtifactReviewErrorCode =
  | "ARTIFACT_PATCH_MISSING"
  | "ARTIFACT_PATCH_CORRUPT"
  | "ARTIFACT_UNAUTHORIZED";

export class EditArtifactReviewError extends Error {
  constructor(
    public readonly code: EditArtifactReviewErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EditArtifactReviewError";
  }
}

interface LatestArtifactInput {
  runId: string;
  sessionId?: string;
  userId?: string;
}

interface MessageArtifactInput {
  runId: string;
  assistantMessageId: string;
  userId?: string;
}

interface ArtifactLookupInput {
  artifactId: string;
  userId: string;
}

interface ArtifactDiffInput extends ArtifactLookupInput {
  path: string;
}

export class EditArtifactReviewService {
  constructor(private readonly env: Env) {
    if (!env.EDIT_ARTIFACTS) {
      throw new Error("EDIT_ARTIFACTS binding is unavailable");
    }
  }

  async getLatestReviewSource(
    input: LatestArtifactInput,
  ): Promise<PromptArtifactReviewSource | null> {
    const artifact = await withArtifactRepository(this.env, (repository) =>
      this.loadLatestArtifact(repository, input),
    );
    return artifact ? this.toReviewSource(artifact) : null;
  }

  async getReviewSourceByMessage(
    input: MessageArtifactInput,
  ): Promise<PromptArtifactReviewSource | null> {
    const artifact = await withArtifactRepository(this.env, (repository) =>
      this.loadMessageArtifact(repository, input),
    );
    return artifact ? this.toReviewSource(artifact) : null;
  }

  async getArtifactFiles(
    input: ArtifactLookupInput,
  ): Promise<EditArtifactReviewFile[]> {
    const artifact = await this.loadUserArtifact(input);
    return this.toReviewFiles(artifact);
  }

  async getArtifactDiff(
    input: ArtifactDiffInput,
  ): Promise<EditArtifactDiffResponse> {
    const artifact = await this.loadUserArtifact(input);
    const patch = await this.readVerifiedPatch(artifact);
    const diff = parseArtifactDiff(patch, input.path);
    return {
      artifactId: artifact.id,
      path: input.path,
      source: "artifact_patch",
      diff,
    };
  }

  private async loadLatestArtifact(
    repository: ArtifactRepository,
    input: LatestArtifactInput,
  ): Promise<EditArtifactRecord | null> {
    if (input.userId) {
      return await repository.getLatestReviewArtifact({
        runId: input.runId,
        userId: input.userId,
        sessionId: input.sessionId,
      });
    }
    return await repository.getLatestReviewArtifactForRun({
      runId: input.runId,
      sessionId: input.sessionId,
    });
  }

  private async loadMessageArtifact(
    repository: ArtifactRepository,
    input: MessageArtifactInput,
  ): Promise<EditArtifactRecord | null> {
    if (input.userId) {
      return await repository.getReviewArtifactByMessage({
        runId: input.runId,
        userId: input.userId,
        assistantMessageId: input.assistantMessageId,
      });
    }
    return await repository.getReviewArtifactByMessageForRun({
      runId: input.runId,
      assistantMessageId: input.assistantMessageId,
    });
  }

  private async loadUserArtifact(
    input: ArtifactLookupInput,
  ): Promise<EditArtifactRecord> {
    const artifact = await withArtifactRepository(this.env, (repository) =>
      repository.getArtifactById(input.artifactId, input.userId),
    );
    if (!artifact) {
      throw new EditArtifactReviewError(
        "ARTIFACT_UNAUTHORIZED",
        "Saved edit artifact is not available for this user.",
      );
    }
    return artifact;
  }

  private toReviewSource(
    artifact: EditArtifactRecord,
  ): PromptArtifactReviewSource {
    return {
      kind: "prompt_artifact",
      artifactId: artifact.id,
      runId: artifact.runId,
      sessionId: artifact.sessionId,
      workspaceId: artifact.workspaceId,
      userMessageId: artifact.userMessageId ?? undefined,
      assistantMessageId: artifact.assistantMessageId ?? undefined,
      sourceTurnId: artifact.sourceTurnId ?? undefined,
      status: toReviewStatus(artifact.status),
      files: this.toReviewFiles(artifact),
      createdAt: artifact.createdAt,
      storageBackend: artifact.storageBackend ?? "r2_postgres",
    };
  }

  private toReviewFiles(
    artifact: EditArtifactRecord,
  ): EditArtifactReviewFile[] {
    return artifact.changedFiles.map((file) => ({
      path: file.path,
      status: normalizeReviewStatus(file.status),
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
      isStaged: file.isStaged ?? undefined,
      diffAvailable: artifact.artifactKind === "git_patch",
      artifactPath: file.path,
    }));
  }

  private async readVerifiedPatch(
    artifact: EditArtifactRecord,
  ): Promise<string> {
    const backend = createEditArtifactStorageBackend(this.env);
    const patch = await backend.readPatch({ artifact });
    if (!patch) {
      throw new EditArtifactReviewError(
        "ARTIFACT_PATCH_MISSING",
        "Saved edit artifact patch is missing.",
      );
    }

    const expectedSha = artifact.patchSha256 ?? artifact.sha256;
    if (expectedSha && (await sha256Hex(patch)) !== expectedSha) {
      throw new EditArtifactReviewError(
        "ARTIFACT_PATCH_CORRUPT",
        "Saved edit artifact patch failed integrity verification.",
      );
    }

    return patch;
  }
}

function parseArtifactDiff(patch: string, path: string): DiffContent {
  try {
    return parsePatchFileDiff({ patch, path });
  } catch (error) {
    if (error instanceof EditArtifactPatchParseError) {
      throw new EditArtifactReviewError(
        "ARTIFACT_PATCH_CORRUPT",
        error.message,
      );
    }
    throw error;
  }
}

function toReviewStatus(
  status: EditArtifactRecord["status"],
): PromptArtifactReviewSource["status"] {
  if (status === "restored") {
    return "restored";
  }
  if (status === "requires_user_resolution") {
    return "requires_user_resolution";
  }
  return "stored";
}

function normalizeReviewStatus(status: string): EditArtifactReviewFile["status"] {
  if (
    status === "added" ||
    status === "modified" ||
    status === "deleted" ||
    status === "renamed" ||
    status === "untracked"
  ) {
    return status;
  }
  return "modified";
}

export function parseArtifactPatchInventoryForReview(
  patch: string,
): EditArtifactReviewFile[] {
  try {
    return parsePatchFileInventory(patch);
  } catch (error) {
    if (error instanceof EditArtifactPatchParseError) {
      throw new EditArtifactReviewError(
        "ARTIFACT_PATCH_CORRUPT",
        error.message,
      );
    }
    throw error;
  }
}
