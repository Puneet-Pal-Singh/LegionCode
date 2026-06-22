import type {
  ArtifactAccessContext,
  ArtifactMetadata,
  ArtifactOwnership,
  TurnDiffPayload,
  TurnWorkspaceSnapshot,
} from "@repo/artifact-store";
import type { GitWorkspaceSnapshot } from "@repo/git-service";
import type { Run, Turn } from "@repo/platform-protocol";
import type { WorkspaceManifest } from "@repo/workspace-core";
import { RuntimeKernelError } from "./errors.js";
import type {
  RuntimeGitSnapshotPort,
  RuntimeKernelClock,
  RuntimeTurnArtifactPort,
} from "./ports.js";

interface TurnArtifactSettlementOptions {
  readonly git: RuntimeGitSnapshotPort;
  readonly artifacts: RuntimeTurnArtifactPort;
  readonly clock: RuntimeKernelClock;
  readonly run: Run;
  readonly turn: Turn;
  readonly workspace: WorkspaceManifest;
}

export interface TurnArtifactSettlementResult {
  readonly terminalSnapshot: TurnWorkspaceSnapshot;
  readonly terminalSnapshotArtifact: ArtifactMetadata;
  readonly turnDiff: TurnDiffPayload;
  readonly turnDiffArtifact: ArtifactMetadata;
}

export class TurnArtifactSettlementCoordinator {
  private startSnapshot: TurnWorkspaceSnapshot | null = null;
  private startSnapshotArtifact: ArtifactMetadata | null = null;
  private settlement: Promise<TurnArtifactSettlementResult> | null = null;

  constructor(private readonly options: TurnArtifactSettlementOptions) {}

  async begin(): Promise<{
    snapshot: TurnWorkspaceSnapshot;
    artifact: ArtifactMetadata;
  }> {
    if (this.startSnapshot && this.startSnapshotArtifact) {
      return {
        snapshot: this.startSnapshot,
        artifact: this.startSnapshotArtifact,
      };
    }
    const snapshot = await this.capture("start");
    const artifact = await this.options.artifacts.putSnapshot({
      snapshot,
      ownership: this.ownership(),
      access: this.access(),
    });
    this.startSnapshot = snapshot;
    this.startSnapshotArtifact = artifact;
    return { snapshot, artifact };
  }

  async settle(): Promise<TurnArtifactSettlementResult> {
    if (!this.startSnapshot) {
      throw new RuntimeKernelError(
        "turn_artifact_settlement_failed",
        `Turn ${this.options.turn.id} has no start snapshot`,
      );
    }
    if (!this.settlement) {
      this.settlement = this.settleNow().catch((error: unknown) => {
        this.settlement = null;
        throw error;
      });
    }
    return await this.settlement;
  }

  private async settleNow(): Promise<TurnArtifactSettlementResult> {
    const startSnapshot = this.requireStartSnapshot();
    const terminalSnapshot = await this.capture("terminal");
    const diff = await this.options.git.getSnapshotDiff({
      workspace: this.gitWorkspace(),
      start: toGitSnapshot(startSnapshot, this.options),
      terminal: toGitSnapshot(terminalSnapshot, this.options),
    });
    const terminalSnapshotArtifact = await this.options.artifacts.putSnapshot({
      snapshot: terminalSnapshot,
      ownership: this.ownership(),
      access: this.access(),
    });
    const turnDiff = {
      turnId: this.options.turn.id,
      startSnapshot,
      terminalSnapshot,
      files: [...diff.files],
      patch: diff.patch,
    } satisfies TurnDiffPayload;
    const turnDiffArtifact = await this.options.artifacts.putTurnDiff({
      diff: turnDiff,
      ownership: this.ownership(),
      access: this.access(),
    });
    return {
      terminalSnapshot,
      terminalSnapshotArtifact,
      turnDiff,
      turnDiffArtifact,
    };
  }

  private async capture(
    phase: TurnWorkspaceSnapshot["phase"],
  ): Promise<TurnWorkspaceSnapshot> {
    const snapshot = await this.options.git.captureSnapshot({
      workspace: this.gitWorkspace(),
      snapshotKey: this.options.turn.id,
    });
    return {
      turnId: this.options.turn.id,
      snapshotKey: this.options.turn.id,
      treeId: snapshot.treeId,
      headSha: snapshot.headSha,
      phase,
      capturedAt: this.options.clock.now(),
    };
  }

  private gitWorkspace() {
    return {
      runId: this.options.run.id,
      filesystemRoot: this.options.workspace.filesystemRoot,
    };
  }

  private ownership(): ArtifactOwnership {
    return {
      createdBy: this.options.run.userId,
      workspaceId: this.options.run.workspaceId,
      threadId: this.options.run.threadId,
      runId: this.options.run.id,
    };
  }

  private access(): ArtifactAccessContext {
    return {
      userId: this.options.run.userId,
      workspaceId: this.options.run.workspaceId,
      threadId: this.options.run.threadId,
      runId: this.options.run.id,
    };
  }

  private requireStartSnapshot(): TurnWorkspaceSnapshot {
    if (!this.startSnapshot) {
      throw new RuntimeKernelError(
        "turn_artifact_settlement_failed",
        `Turn ${this.options.turn.id} has no start snapshot`,
      );
    }
    return this.startSnapshot;
  }
}

function toGitSnapshot(
  snapshot: TurnWorkspaceSnapshot,
  options: TurnArtifactSettlementOptions,
): GitWorkspaceSnapshot {
  return {
    runId: options.run.id,
    filesystemRoot: options.workspace.filesystemRoot,
    headSha: snapshot.headSha,
    treeId: snapshot.treeId,
  };
}
