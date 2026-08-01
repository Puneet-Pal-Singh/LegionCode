import type {
  RuntimeGitSnapshotPort,
  RuntimeGitWorkspaceSnapshot,
} from "@repo/runtime-kernel";
import { SecureGitArtifactClient } from "./SecureGitArtifactClient";

/**
 * Canonical runtime snapshot adapter for the secure cloud checkout.
 *
 * The runtime kernel owns turn boundaries and diff settlement. This adapter
 * only translates the secure Git service into that narrow runtime port.
 */
export class SecureRuntimeGitSnapshotPort implements RuntimeGitSnapshotPort {
  constructor(private readonly client: SecureGitArtifactClient) {}

  async captureSnapshot(
    input: Parameters<RuntimeGitSnapshotPort["captureSnapshot"]>[0],
  ): Promise<RuntimeGitWorkspaceSnapshot> {
    const treeId = await this.client.captureWorktreeSnapshot();
    return {
      runId: input.workspace.runId,
      filesystemRoot: input.workspace.filesystemRoot,
      headSha: treeId,
      treeId,
    };
  }

  async getSnapshotDiff(
    input: Parameters<RuntimeGitSnapshotPort["getSnapshotDiff"]>[0],
  ): Promise<Awaited<ReturnType<RuntimeGitSnapshotPort["getSnapshotDiff"]>>> {
    return await this.client.diffWorktreeSnapshots({
      startTree: input.start.treeId,
      terminalTree: input.terminal.treeId,
    });
  }
}
