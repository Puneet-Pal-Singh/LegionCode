import type { RunId } from "@repo/platform-protocol";
import {
  type WorkspaceManifest,
  type WorkspaceManifestRepository,
} from "@repo/workspace-core";
import { RuntimeKernelError } from "./errors.js";

const EXECUTABLE_STATES = new Set<WorkspaceManifest["state"]>([
  "ready",
  "dirty",
  "committed",
  "pushed",
  "pr_opened",
]);

export class WorkspaceCoordinator {
  constructor(private readonly repository: WorkspaceManifestRepository) {}

  async loadExecutableManifest(runId: RunId): Promise<WorkspaceManifest> {
    const manifest = await this.repository.getLatestByRunId(runId);
    if (!manifest) {
      throw new RuntimeKernelError(
        "workspace_not_found",
        `No durable workspace manifest exists for run ${runId}`,
      );
    }
    if (!EXECUTABLE_STATES.has(manifest.state)) {
      throw new RuntimeKernelError(
        "workspace_not_executable",
        `Workspace ${manifest.workspaceId} is not executable in state ${manifest.state}`,
      );
    }
    return manifest;
  }
}
