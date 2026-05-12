import type { EditArtifactRecord, GitStatusResponse } from "@repo/shared-types";
import type { Env } from "../../types/ai";
import { D1EditArtifactRepository } from "./D1EditArtifactRepository";
import { EditArtifactObjectStore } from "./EditArtifactObjectStore";
import { SecureGitArtifactClient } from "./SecureGitArtifactClient";
import { changedFilesFromStatus } from "./EditArtifactCaptureService";
import { ensureByokSchemaReady } from "../byok/ByokSchemaService";

export class EditArtifactRestoreService {
  private readonly repository: D1EditArtifactRepository;
  private readonly objectStore: EditArtifactObjectStore;

  constructor(private readonly env: Env) {
    this.repository = new D1EditArtifactRepository(env.BYOK_DB);
    if (!env.EDIT_ARTIFACTS) {
      throw new Error("EDIT_ARTIFACTS binding is unavailable");
    }
    this.objectStore = new EditArtifactObjectStore(env.EDIT_ARTIFACTS);
  }

  async restoreLatestIfWorkspaceIsEmpty(input: {
    runId: string;
    muscleSession: string;
    currentStatus: GitStatusResponse;
  }): Promise<"not-needed" | "restored" | "requires-user-resolution"> {
    if (!shouldRestore(input.currentStatus)) {
      return "not-needed";
    }

    await ensureByokSchemaReady(this.env.BYOK_DB);
    const artifact = await this.loadRestorableArtifact(input.runId);
    if (!artifact) {
      return "not-needed";
    }

    await this.markRestoreAttempted(artifact, input.runId);

    const patch = await this.objectStore.readPatch(artifact.r2ObjectKey);
    if (!patch) {
      await this.markRestoreFailed(
        artifact.id,
        input.runId,
        "Patch object missing",
      );
      return "requires-user-resolution";
    }

    try {
      await this.applyPatch(input, patch);
      await this.markRestored(artifact.id, input.runId);
      return "restored";
    } catch (error) {
      const message = error instanceof Error ? error.message : "Restore failed";
      await this.markRequiresResolution(artifact.id, input.runId, message);
      return "requires-user-resolution";
    }
  }

  private async loadRestorableArtifact(
    runId: string,
  ): Promise<EditArtifactRecord | null> {
    const artifact = await this.repository.getLatestRestorableArtifact(runId);
    return artifact?.status === "requires_user_resolution" ? null : artifact;
  }

  private async markRestoreAttempted(
    artifact: EditArtifactRecord,
    runId: string,
  ): Promise<void> {
    await this.repository.updateStatus({
      artifactId: artifact.id,
      status: "restore_in_progress",
    });
    await this.repository.appendEvent({
      id: crypto.randomUUID(),
      artifactId: artifact.id,
      runId,
      eventType: "restore_attempted",
      message: "Applying latest saved edit artifact after workspace bootstrap",
      metadata: { r2ObjectKey: artifact.r2ObjectKey },
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

  private async markRestored(artifactId: string, runId: string): Promise<void> {
    await this.repository.updateStatus({
      artifactId,
      status: "restored",
    });
    await this.repository.appendEvent({
      id: crypto.randomUUID(),
      artifactId,
      runId,
      eventType: "restored",
      message: "Saved edit artifact restored into workspace",
    });
  }

  private async markRestoreFailed(
    artifactId: string,
    runId: string,
    message: string,
  ): Promise<void> {
    await this.repository.updateStatus({
      artifactId,
      status: "restore_failed",
    });
    await this.repository.appendEvent({
      id: crypto.randomUUID(),
      artifactId,
      runId,
      eventType: "restore_failed",
      message,
    });
  }

  private async markRequiresResolution(
    artifactId: string,
    runId: string,
    message: string,
  ): Promise<void> {
    await this.repository.updateStatus({
      artifactId,
      status: "requires_user_resolution",
    });
    await this.repository.appendEvent({
      id: crypto.randomUUID(),
      artifactId,
      runId,
      eventType: "requires_user_resolution",
      message,
    });
  }
}

export function canRestoreEditArtifacts(env: Env): boolean {
  return Boolean(env.EDIT_ARTIFACTS && env.BYOK_DB);
}

function shouldRestore(status: GitStatusResponse): boolean {
  return status.gitAvailable && changedFilesFromStatus(status).length === 0;
}
