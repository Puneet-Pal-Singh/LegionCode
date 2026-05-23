import type { EditArtifactRecord, GitStatusResponse } from "@repo/shared-types";
import type { Env } from "../../types/ai";
import { EditArtifactObjectStore } from "./EditArtifactObjectStore";
import { SecureGitArtifactClient } from "./SecureGitArtifactClient";
import { changedFilesFromStatus } from "./EditArtifactCaptureService";
import { withArtifactRepository } from "./ArtifactPersistenceFactory";

type RestoreResult = "not-needed" | "restored" | "requires-user-resolution";

const restoreRequestsByRun = new Map<string, Promise<RestoreResult>>();

export class EditArtifactRestoreService {
  private readonly objectStore: EditArtifactObjectStore;

  constructor(private readonly env: Env) {
    if (!env.EDIT_ARTIFACTS) {
      throw new Error("EDIT_ARTIFACTS binding is unavailable");
    }
    this.objectStore = new EditArtifactObjectStore(env.EDIT_ARTIFACTS);
  }

  async restoreLatestIfWorkspaceIsEmpty(input: {
    userId: string;
    runId: string;
    muscleSession: string;
    currentStatus: GitStatusResponse;
  }): Promise<RestoreResult> {
    const restoreKey = `${input.userId}:${input.runId}`;
    const existingRequest = restoreRequestsByRun.get(restoreKey);
    if (existingRequest) {
      return await existingRequest;
    }

    const restoreRequest = this.restoreLatestIfWorkspaceIsEmptyOnce(input);
    restoreRequestsByRun.set(restoreKey, restoreRequest);
    try {
      return await restoreRequest;
    } finally {
      if (restoreRequestsByRun.get(restoreKey) === restoreRequest) {
        restoreRequestsByRun.delete(restoreKey);
      }
    }
  }

  private async restoreLatestIfWorkspaceIsEmptyOnce(input: {
    userId: string;
    runId: string;
    muscleSession: string;
    currentStatus: GitStatusResponse;
  }): Promise<RestoreResult> {
    if (!shouldRestore(input.currentStatus)) {
      return "not-needed";
    }

    const artifact = await this.loadRestorableArtifact(input.runId, input.userId);
    if (!artifact) {
      return "not-needed";
    }

    await this.markRestoreAttempted(artifact, input.runId);

    const patch = await this.objectStore.readPatch(artifact.r2ObjectKey);
    if (!patch) {
      await this.markRestoreFailed(artifact, input.runId, "Patch object missing");
      return "requires-user-resolution";
    }

    try {
      await this.applyPatch(input, patch);
      await this.markRestored(artifact, input.runId);
      return "restored";
    } catch (error) {
      const message = error instanceof Error ? error.message : "Restore failed";
      await this.markRequiresResolution(artifact, input.runId, message);
      return "requires-user-resolution";
    }
  }

  private async loadRestorableArtifact(
    runId: string,
    userId: string,
  ): Promise<EditArtifactRecord | null> {
    const artifact = await withArtifactRepository(this.env, async (repository) => {
      return await repository.getLatestRestorableArtifact(runId, userId);
    });
    return artifact;
  }

  private async markRestoreAttempted(
    artifact: EditArtifactRecord,
    runId: string,
  ): Promise<void> {
    await withArtifactRepository(this.env, async (repository) => {
      await repository.transaction(async (txRepository) => {
        await txRepository.updateStatus({
          artifactId: artifact.id,
          userId: artifact.userId,
          status: "restore_in_progress",
        });
        await txRepository.appendEvent({
          id: crypto.randomUUID(),
          artifactId: artifact.id,
          runId,
          eventType: "restore_attempted",
          message: "Applying latest saved edit artifact after workspace bootstrap",
          metadata: { r2ObjectKey: artifact.r2ObjectKey },
        });
      });
    });
  }

  private async applyPatch(
    input: { runId: string; muscleSession: string },
    patch: string,
  ): Promise<void> {
    const gitClient = new SecureGitArtifactClient(
      this.env,
      input.muscleSession,
      input.runId,
    );
    await gitClient.applyPatch(patch);
  }

  private async markRestored(
    artifact: EditArtifactRecord,
    runId: string,
  ): Promise<void> {
    await withArtifactRepository(this.env, async (repository) => {
      await repository.transaction(async (txRepository) => {
        await txRepository.updateStatus({
          artifactId: artifact.id,
          userId: artifact.userId,
          status: "restored",
        });
        await txRepository.appendEvent({
          id: crypto.randomUUID(),
          artifactId: artifact.id,
          runId,
          eventType: "restored",
          message: "Saved edit artifact restored into workspace",
        });
      });
    });
  }

  private async markRestoreFailed(
    artifact: EditArtifactRecord,
    runId: string,
    message: string,
  ): Promise<void> {
    await withArtifactRepository(this.env, async (repository) => {
      await repository.transaction(async (txRepository) => {
        await txRepository.updateStatus({
          artifactId: artifact.id,
          userId: artifact.userId,
          status: "restore_failed",
        });
        await txRepository.appendEvent({
          id: crypto.randomUUID(),
          artifactId: artifact.id,
          runId,
          eventType: "restore_failed",
          message,
        });
      });
    });
  }

  private async markRequiresResolution(
    artifact: EditArtifactRecord,
    runId: string,
    message: string,
  ): Promise<void> {
    await withArtifactRepository(this.env, async (repository) => {
      await repository.transaction(async (txRepository) => {
        await txRepository.updateStatus({
          artifactId: artifact.id,
          userId: artifact.userId,
          status: "requires_user_resolution",
        });
        await txRepository.appendEvent({
          id: crypto.randomUUID(),
          artifactId: artifact.id,
          runId,
          eventType: "requires_user_resolution",
          message,
        });
      });
    });
  }
}

export function canRestoreEditArtifacts(env: Env): boolean {
  return Boolean(env.EDIT_ARTIFACTS && (env.HYPERDRIVE || env.AUTH_ARTIFACT_REPOSITORY));
}

function shouldRestore(status: GitStatusResponse): boolean {
  return status.gitAvailable && changedFilesFromStatus(status).length === 0;
}
