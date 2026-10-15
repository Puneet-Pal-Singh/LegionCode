import type {
  RuntimeGitSnapshotPort,
  RuntimeGitWorkspaceSnapshot,
} from "@repo/runtime-kernel";
import type { ResumeWorkspaceSnapshotRef } from "@repo/platform-protocol";
import { SecureGitArtifactClient } from "./SecureGitArtifactClient";
import { ResumeWorkspaceSnapshotStore } from "../../runtime/task-workspaces/ResumeWorkspaceSnapshotStore";
import type { R2Bucket } from "@cloudflare/workers-types";

export interface ResumeWorkspaceSnapshotCaptureScope {
  readonly bucket: R2Bucket;
  readonly userId: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly sourceRunId: string;
  readonly sourceTurnId: string;
  readonly sourceRunAttemptId: string;
  readonly baseSnapshotId: string;
  readonly baseCommitSha: string;
}

/**
 * Canonical runtime snapshot adapter for the secure cloud checkout.
 *
 * The runtime kernel owns turn boundaries and diff settlement. This adapter
 * only translates the secure Git service into that narrow runtime port.
 */
export class SecureRuntimeGitSnapshotPort implements RuntimeGitSnapshotPort {
  constructor(
    private readonly client: SecureGitArtifactClient,
    private readonly resumeCapture?: ResumeWorkspaceSnapshotCaptureScope,
  ) {}

  async captureSnapshot(
    input: Parameters<RuntimeGitSnapshotPort["captureSnapshot"]>[0],
  ): Promise<RuntimeGitWorkspaceSnapshot> {
    const { treeSha: treeId, headSha } =
      await this.client.captureWorktreeSnapshot();
    return {
      runId: input.workspace.runId,
      filesystemRoot: input.workspace.filesystemRoot,
      headSha,
      treeId,
    };
  }

  async captureResumeSnapshot(input: {
    readonly workspace: {
      readonly runId: string;
      readonly filesystemRoot: string;
    };
    readonly terminal: RuntimeGitWorkspaceSnapshot;
  }): Promise<ResumeWorkspaceSnapshotRef> {
    const scope = this.resumeCapture;
    if (!scope || scope.sourceRunId !== input.workspace.runId) {
      throw new Error(
        "Interrupted workspace snapshot capture is not configured",
      );
    }
    const exported = await this.client.exportWorktreeSnapshotPatch({
      baseCommitSha: scope.baseCommitSha,
      terminalTreeSha: input.terminal.treeId,
    });
    return await new ResumeWorkspaceSnapshotStore(scope.bucket).write({
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      threadId: scope.threadId,
      sourceRunId: scope.sourceRunId,
      sourceTurnId: scope.sourceTurnId,
      sourceRunAttemptId: scope.sourceRunAttemptId,
      baseSnapshotId: scope.baseSnapshotId,
      baseCommitSha: exported.baseCommitSha,
      terminalTreeSha: exported.terminalTreeSha,
      patch: exported.patch,
    });
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
