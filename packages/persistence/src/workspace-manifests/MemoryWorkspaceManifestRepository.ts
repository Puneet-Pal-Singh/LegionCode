import {
  RunIdSchema,
  WorkspaceManifestIdSchema,
  WorkspaceManifestSchema,
  type RunId,
  type WorkspaceManifest,
  type WorkspaceManifestId,
} from "@repo/platform-protocol";
import {
  WorkspaceManifestError,
  assertWorkspaceManifestIdentityUnchanged,
  transitionWorkspaceManifestState,
  type SaveWorkspaceManifestInput,
  type TransitionWorkspaceManifestInput,
  type WorkspaceManifestRepository,
} from "./types.js";

export class MemoryWorkspaceManifestRepository
  implements WorkspaceManifestRepository
{
  private readonly manifests = new Map<string, WorkspaceManifest>();

  async saveManifest(
    input: SaveWorkspaceManifestInput,
  ): Promise<WorkspaceManifest> {
    const manifest = WorkspaceManifestSchema.parse(input.manifest);
    const existing = this.manifests.get(manifest.manifestId);
    if (existing) {
      assertWorkspaceManifestIdentityUnchanged(existing, manifest);
    }
    this.manifests.set(manifest.manifestId, manifest);
    return manifest;
  }

  async transitionManifest(
    input: TransitionWorkspaceManifestInput,
  ): Promise<WorkspaceManifest> {
    const manifestId = WorkspaceManifestIdSchema.parse(input.manifestId);
    const current = this.requireManifest(manifestId);
    const next = WorkspaceManifestSchema.parse({
      ...current,
      state: transitionWorkspaceManifestState(
        current.state,
        input.nextState,
      ),
      headCommitSha: input.headCommitSha,
      lastError: input.lastError,
      updatedAt: input.updatedAt,
    });
    this.manifests.set(next.manifestId, next);
    return next;
  }

  async getManifest(
    manifestId: WorkspaceManifestId,
  ): Promise<WorkspaceManifest | null> {
    return this.manifests.get(WorkspaceManifestIdSchema.parse(manifestId)) ?? null;
  }

  async getLatestManifestForRun(
    runId: RunId,
  ): Promise<WorkspaceManifest | null> {
    const parsedRunId = RunIdSchema.parse(runId);
    const manifests = [...this.manifests.values()]
      .filter((manifest) => manifest.runId === parsedRunId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return manifests[0] ?? null;
  }

  private requireManifest(
    manifestId: WorkspaceManifestId,
  ): WorkspaceManifest {
    const manifest = this.manifests.get(manifestId);
    if (!manifest) {
      throw new WorkspaceManifestError(
        "manifest_not_found",
        `Workspace manifest not found: ${manifestId}`,
      );
    }
    return manifest;
  }
}
