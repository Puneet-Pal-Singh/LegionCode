import type { RunId, WorkspaceId } from "@repo/platform-protocol";
import {
  parseWorkspaceManifest,
  validateWorkspaceManifestUpdate,
  type WorkspaceManifest,
} from "./manifest.js";
import {
  createManifestAlreadyExistsError,
  createManifestNotFoundError,
} from "./errors.js";
import type { WorkspaceTransitionOptions } from "./state-machine.js";

export interface WorkspaceManifestRepository {
  create(manifest: WorkspaceManifest): Promise<WorkspaceManifest>;
  update(
    manifest: WorkspaceManifest,
    options?: WorkspaceTransitionOptions,
  ): Promise<WorkspaceManifest>;
  getByWorkspaceId(workspaceId: WorkspaceId): Promise<WorkspaceManifest | null>;
  getLatestByRunId(runId: RunId): Promise<WorkspaceManifest | null>;
}

export class MemoryWorkspaceManifestRepository
  implements WorkspaceManifestRepository
{
  private readonly manifestsByWorkspaceId = new Map<
    WorkspaceId,
    WorkspaceManifest
  >();
  private readonly workspaceIdsByRunId = new Map<RunId, WorkspaceId[]>();

  async create(manifest: WorkspaceManifest): Promise<WorkspaceManifest> {
    const parsed = cloneManifest(parseWorkspaceManifest(manifest));
    if (this.manifestsByWorkspaceId.has(parsed.workspaceId)) {
      throw createManifestAlreadyExistsError(parsed.workspaceId);
    }

    this.manifestsByWorkspaceId.set(parsed.workspaceId, parsed);
    this.appendRunWorkspaceId(parsed.runId, parsed.workspaceId);
    return cloneManifest(parsed);
  }

  async update(
    manifest: WorkspaceManifest,
    options: WorkspaceTransitionOptions = {},
  ): Promise<WorkspaceManifest> {
    const current = this.manifestsByWorkspaceId.get(manifest.workspaceId);
    if (!current) {
      throw createManifestNotFoundError(manifest.workspaceId);
    }

    const next = cloneManifest(
      validateWorkspaceManifestUpdate(current, manifest, options),
    );
    this.manifestsByWorkspaceId.set(next.workspaceId, next);
    return cloneManifest(next);
  }

  async getByWorkspaceId(
    workspaceId: WorkspaceId,
  ): Promise<WorkspaceManifest | null> {
    const manifest = this.manifestsByWorkspaceId.get(workspaceId);
    return manifest ? cloneManifest(manifest) : null;
  }

  async getLatestByRunId(runId: RunId): Promise<WorkspaceManifest | null> {
    const workspaceIds = this.workspaceIdsByRunId.get(runId) ?? [];
    const latestWorkspaceId = workspaceIds.at(-1);
    if (!latestWorkspaceId) {
      return null;
    }

    return await this.getByWorkspaceId(latestWorkspaceId);
  }

  private appendRunWorkspaceId(runId: RunId, workspaceId: WorkspaceId): void {
    const workspaceIds = this.workspaceIdsByRunId.get(runId) ?? [];
    this.workspaceIdsByRunId.set(runId, [...workspaceIds, workspaceId]);
  }
}

function cloneManifest(manifest: WorkspaceManifest): WorkspaceManifest {
  return { ...manifest };
}
