import type { GitStatusResponse } from "@repo/shared-types";
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
    if (!input.currentStatus.gitAvailable) {
      return "not-needed";
    }
    if (changedFilesFromStatus(input.currentStatus).length > 0) {
      return "not-needed";
    }

    await ensureByokSchemaReady(this.env.BYOK_DB);
    const artifact = await this.repository.getLatestRestorableArtifact(
      input.runId,
    );
    if (!artifact || artifact.status === "requires_user_resolution") {
      return "not-needed";
    }

    await this.repository.updateStatus({
      artifactId: artifact.id,
      status: "restore_in_progress",
    });
    await this.repository.appendEvent({
      id: crypto.randomUUID(),
      artifactId: artifact.id,
      runId: input.runId,
      eventType: "restore_attempted",
      message: "Applying latest saved edit artifact after workspace bootstrap",
      metadata: { r2ObjectKey: artifact.r2ObjectKey },
    });

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
      const gitClient = new SecureGitArtifactClient(
        this.env,
        input.muscleSession,
        input.runId,
      );
      await gitClient.applyPatch(patch);
      await this.repository.updateStatus({
        artifactId: artifact.id,
        status: "restored",
      });
      await this.repository.appendEvent({
        id: crypto.randomUUID(),
        artifactId: artifact.id,
        runId: input.runId,
        eventType: "restored",
        message: "Saved edit artifact restored into workspace",
      });
      return "restored";
    } catch (error) {
      const message = error instanceof Error ? error.message : "Restore failed";
      await this.markRequiresResolution(artifact.id, input.runId, message);
      return "requires-user-resolution";
    }
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
