import type {
  ArtifactChangedFile,
  Run,
  Turn,
  TurnDiffPayload,
  TurnWorkspaceSnapshot,
  ResumeWorkspaceUnavailableReason,
} from "@repo/platform-protocol";
import type { WorkspaceManifest } from "@repo/workspace-core";
import { RuntimeKernelError } from "./errors.js";
import type {
  RuntimeGitSnapshotPort,
  RuntimeGitDiffFile,
  RuntimeGitWorkspaceSnapshot,
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
  readonly terminalSnapshot?: TurnWorkspaceSnapshot;
  readonly terminalSnapshotArtifact?: unknown;
  readonly resumeWorkspaceArtifact?: unknown;
  readonly turnDiff?: TurnDiffPayload;
  readonly turnDiffArtifact?: unknown;
  readonly resumeUnavailableReason?: ResumeWorkspaceUnavailableReason;
}

export class TurnArtifactSettlementCoordinator {
  private startSnapshot: TurnWorkspaceSnapshot | null = null;
  private startSnapshotArtifact: unknown = undefined;
  private settlement: Promise<TurnArtifactSettlementResult> | null = null;

  constructor(private readonly options: TurnArtifactSettlementOptions) {}

  async begin(): Promise<{
    snapshot: TurnWorkspaceSnapshot;
    artifact: unknown;
  }> {
    if (this.startSnapshot && this.startSnapshotArtifact !== undefined) {
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

  async settle(
    input: {
      interrupted?: boolean;
      preserveWorkspaceProgress?: boolean;
      resumeUnavailableReason?: ResumeWorkspaceUnavailableReason;
    } = {},
  ): Promise<TurnArtifactSettlementResult> {
    if (!this.startSnapshot) {
      throw new RuntimeKernelError(
        "turn_artifact_settlement_failed",
        `Turn ${this.options.turn.id} has no start snapshot`,
      );
    }
    if (!this.settlement) {
      this.settlement = this.settleNow(input).catch((error: unknown) => {
        this.settlement = null;
        throw error;
      });
    }
    return await this.settlement;
  }

  private async settleNow(input: {
    interrupted?: boolean;
    preserveWorkspaceProgress?: boolean;
    resumeUnavailableReason?: ResumeWorkspaceUnavailableReason;
  }): Promise<TurnArtifactSettlementResult> {
    const startSnapshot = this.requireStartSnapshot();
    if (input.resumeUnavailableReason === "worker_not_quiescent") {
      return { resumeUnavailableReason: input.resumeUnavailableReason };
    }
    let terminalSnapshot: TurnWorkspaceSnapshot;
    try {
      terminalSnapshot = await this.capture(
        "terminal",
        input.preserveWorkspaceProgress === true,
        input.resumeUnavailableReason,
      );
    } catch {
      if (!input.interrupted) throw new RuntimeKernelError(
        "turn_artifact_settlement_failed",
        "Terminal workspace snapshot is unavailable.",
      );
      return { resumeUnavailableReason: "snapshot_unavailable" };
    }
    let diff: Awaited<ReturnType<RuntimeGitSnapshotPort["getSnapshotDiff"]>>;
    try {
      diff = await this.options.git.getSnapshotDiff({
      workspace: this.gitWorkspace(),
      start: toGitSnapshot(startSnapshot, this.options),
      terminal: toGitSnapshot(terminalSnapshot, this.options),
      });
    } catch {
      if (!input.interrupted) throw new RuntimeKernelError(
        "turn_artifact_settlement_failed",
        "Terminal workspace diff is unavailable.",
      );
      return {
        terminalSnapshot,
        resumeUnavailableReason: "snapshot_unavailable",
      };
    }
    let terminalSnapshotArtifact: unknown;
    try {
      terminalSnapshotArtifact = await this.options.artifacts.putSnapshot({
        snapshot: terminalSnapshot,
        ownership: this.ownership(),
        access: this.access(),
      });
    } catch {
      if (!input.interrupted) throw new RuntimeKernelError(
        "turn_artifact_settlement_failed",
        "Terminal workspace snapshot artifact could not be persisted.",
      );
      return {
        terminalSnapshot,
        resumeUnavailableReason: "snapshot_unavailable",
      };
    }
    const resumeWorkspaceArtifact = terminalSnapshot.resumeSnapshotRef
      ? {
          artifactId: terminalSnapshot.resumeSnapshotRef.artifactId,
          kind: "workspace_snapshot",
          threadId: this.options.run.threadId,
          runId: this.options.run.id,
          workspaceId: this.options.run.workspaceId,
          itemId: null,
          label: "Interrupted workspace progress",
          payloadRef: {
            backend: "r2",
            objectKey: terminalSnapshot.resumeSnapshotRef.payloadObjectKey,
            uri: null,
            contentType: "application/vnd.git.patch",
            sizeBytes: terminalSnapshot.resumeSnapshotRef.byteLength,
            sha256: terminalSnapshot.resumeSnapshotRef.patchSha256,
          },
          changedFiles: [],
          metadata: {
            role: "resume_workspace_progress",
            sourceUserId: terminalSnapshot.resumeSnapshotRef.userId,
            sourceRunId: terminalSnapshot.resumeSnapshotRef.sourceRunId,
            sourceTurnId: terminalSnapshot.resumeSnapshotRef.sourceTurnId,
            sourceRunAttemptId:
              terminalSnapshot.resumeSnapshotRef.sourceRunAttemptId,
            baseSnapshotId: terminalSnapshot.resumeSnapshotRef.baseSnapshotId,
            baseCommitSha: terminalSnapshot.resumeSnapshotRef.baseCommitSha,
            terminalTreeSha:
              terminalSnapshot.resumeSnapshotRef.terminalTreeSha,
            patchSha256: terminalSnapshot.resumeSnapshotRef.patchSha256,
            byteLength: terminalSnapshot.resumeSnapshotRef.byteLength,
          },
          createdAt: terminalSnapshot.capturedAt,
        }
      : undefined;
    const turnDiff = {
      turnId: this.options.turn.id,
      startSnapshot,
      terminalSnapshot,
      files: diff.files.map(toArtifactChangedFile),
      patch: diff.patch,
    } satisfies TurnDiffPayload;
    let turnDiffArtifact: unknown;
    try {
      turnDiffArtifact = await this.options.artifacts.putTurnDiff({
        diff: turnDiff,
        ownership: this.ownership(),
        access: this.access(),
      });
    } catch {
      if (!input.interrupted) throw new RuntimeKernelError(
        "turn_artifact_settlement_failed",
        "Terminal workspace diff artifact could not be persisted.",
      );
      return {
        terminalSnapshot,
        terminalSnapshotArtifact,
        resumeUnavailableReason: "snapshot_unavailable",
      };
    }
    return {
      terminalSnapshot,
      terminalSnapshotArtifact,
      ...(resumeWorkspaceArtifact ? { resumeWorkspaceArtifact } : {}),
      turnDiff,
      turnDiffArtifact,
      ...(terminalSnapshot.resumeUnavailableReason
        ? { resumeUnavailableReason: terminalSnapshot.resumeUnavailableReason }
        : {}),
    };
  }

  private async capture(
    phase: TurnWorkspaceSnapshot["phase"],
    preserveWorkspaceProgress = false,
    resumeUnavailableReason?: ResumeWorkspaceUnavailableReason,
  ): Promise<TurnWorkspaceSnapshot> {
    let snapshot: RuntimeGitWorkspaceSnapshot;
    try {
      snapshot = await this.options.git.captureSnapshot({
        workspace: this.gitWorkspace(),
        snapshotKey: this.options.turn.id,
      });
    } catch {
      if (phase === "terminal") {
        throw new RuntimeKernelError(
          "turn_artifact_settlement_failed",
          "Terminal workspace snapshot is unavailable.",
        );
      }
      throw new RuntimeKernelError(
        "turn_artifact_settlement_failed",
        "Start workspace snapshot is unavailable.",
      );
    }
    let resumeSnapshotRef:
      | Awaited<ReturnType<typeof this.captureResumeSnapshot>>
      | undefined;
    let unavailableReason = resumeUnavailableReason;
    if (phase === "terminal" && preserveWorkspaceProgress && !unavailableReason) {
      try {
        resumeSnapshotRef = await this.captureResumeSnapshot(snapshot);
      } catch (error) {
        unavailableReason = /size limit|too large/iu.test(
          error instanceof Error ? error.message : "",
        )
          ? "snapshot_too_large"
          : "snapshot_unavailable";
      }
    }
    return {
      turnId: this.options.turn.id,
      snapshotKey: this.options.turn.id,
      treeId: snapshot.treeId,
      headSha: snapshot.headSha,
      phase,
      capturedAt: this.options.clock.now(),
      ...(resumeSnapshotRef ? { resumeSnapshotRef } : {}),
      ...(phase === "terminal" && unavailableReason
        ? { resumeUnavailableReason: unavailableReason }
        : {}),
    };
  }

  private async captureResumeSnapshot(terminal: RuntimeGitWorkspaceSnapshot) {
    if (!this.options.git.captureResumeSnapshot) {
      throw new RuntimeKernelError(
        "turn_artifact_settlement_failed",
        "Interrupted turn workspace progress cannot be stored for resume.",
      );
    }
    return await this.options.git.captureResumeSnapshot({
      workspace: this.gitWorkspace(),
      terminal,
    });
  }

  private gitWorkspace() {
    return {
      runId: this.options.run.id,
      filesystemRoot: this.options.workspace.filesystemRoot,
    };
  }

  private ownership() {
    return {
      createdBy: this.options.run.userId,
      workspaceId: this.options.run.workspaceId,
      threadId: this.options.run.threadId,
      runId: this.options.run.id,
    };
  }

  private access() {
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
): RuntimeGitWorkspaceSnapshot {
  return {
    runId: options.run.id,
    filesystemRoot: options.workspace.filesystemRoot,
    headSha: snapshot.headSha,
    treeId: snapshot.treeId,
  };
}

function toArtifactChangedFile(file: RuntimeGitDiffFile): ArtifactChangedFile {
  if (file.status === "unmerged") {
    throw new RuntimeKernelError(
      "turn_artifact_settlement_failed",
      `Snapshot diff cannot contain an unmerged file: ${file.path}`,
    );
  }
  return {
    path: file.path,
    previousPath: file.previousPath,
    status:
      file.status === "type_changed"
        ? "modified"
        : file.status === "untracked"
          ? "added"
          : file.status,
    additions: file.additions,
    deletions: file.deletions,
  };
}
