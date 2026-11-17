import {
  ArtifactMetadataSchema,
  TurnDiffPayloadSchema,
  TurnWorkspaceSnapshotSchema,
  userIdFromExternalId,
  workspaceIdFromExternalId,
  type ArtifactChangedFile,
  type ArtifactMetadata,
  type Run,
  type RunAttemptId,
  type TurnId,
  type TurnWorkspaceSnapshot,
} from "@repo/platform-protocol";
import type { RuntimeTurnArtifactPort } from "@repo/runtime-kernel";
import type { IssuedTaskCheckout } from "../../runtime/task-workspaces/TaskCheckoutIssuer";
import type { Env } from "../../types/ai";
import {
  EditArtifactObjectStore,
  MAX_RUNTIME_TURN_ARTIFACT_BYTES,
} from "./EditArtifactObjectStore";
import { sha256Hex } from "./EditArtifactStorageBackend";

interface AdmittedTurnArtifactScope {
  readonly run: Run;
  readonly turnId: TurnId;
  readonly runAttemptId: RunAttemptId;
  readonly userId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly issued: IssuedTaskCheckout;
  readonly repoOwner: string;
  readonly repoName: string;
  readonly repoUrl: string;
}

type SnapshotInput = Parameters<RuntimeTurnArtifactPort["putSnapshot"]>[0];
type DiffInput = Parameters<RuntimeTurnArtifactPort["putTurnDiff"]>[0];
type ArtifactRole = "snapshot_start" | "snapshot_terminal" | "turn_diff";

/** Blob consumer for the kernel's captured evidence from one admitted attempt. */
export class CanonicalRuntimeTurnArtifactPort implements RuntimeTurnArtifactPort {
  private readonly checkoutScope: string;
  private readonly checkoutId: string;
  private readonly checkoutGeneration: string;
  private readonly owner: {
    readonly userId: Run["userId"];
    readonly workspaceId: Run["workspaceId"];
    readonly threadId: Run["threadId"];
    readonly runId: Run["id"];
    readonly turnId: TurnId;
    readonly runAttemptId: RunAttemptId;
  };

  constructor(
    private readonly env: Env,
    scope: AdmittedTurnArtifactScope,
  ) {
    const { run, issued, turnId, runAttemptId } = scope;
    const { checkout, workspaceScope, authorizedCommitId } = issued;
    if (
      userIdFromExternalId(scope.userId) !== run.userId ||
      workspaceIdFromExternalId(scope.workspaceId) !== run.workspaceId ||
      checkout.workspaceId !== run.workspaceId ||
      checkout.threadId !== run.threadId ||
      checkout.turnId !== turnId ||
      checkout.runAttemptId !== runAttemptId ||
      workspaceScope.workspaceId !== run.workspaceId ||
      workspaceScope.threadId !== run.threadId ||
      workspaceScope.runId !== run.id ||
      workspaceScope.turnId !== turnId ||
      workspaceScope.runAttemptId !== runAttemptId ||
      workspaceScope.root !== checkout.filesystemRoot
    ) {
      throw new Error("Artifact checkout differs from admitted ownership");
    }

    this.owner = {
      userId: run.userId,
      workspaceId: run.workspaceId,
      threadId: run.threadId,
      runId: run.id,
      turnId,
      runAttemptId,
    };
    this.checkoutId = checkout.checkoutId;
    this.checkoutGeneration = String(checkout.generation);
    // Keep the attempt's key fixed if checkout provenance drifts. Readback then
    // rejects the conflicting scope instead of admitting a second artifact.
    this.checkoutScope = JSON.stringify([
      scope.userId,
      scope.workspaceId,
      scope.sessionId,
      scope.repoOwner,
      scope.repoName,
      scope.repoUrl,
      authorizedCommitId,
      checkout.checkoutId,
      checkout.snapshotId,
      checkout.secureSessionId,
      checkout.leaseId,
      checkout.sandboxId,
      checkout.generation,
      checkout.filesystemRoot,
      checkout.gitDir,
      checkout.indexFile,
      checkout.workingBranch,
      checkout.startTreeId,
      checkout.createdAt,
    ]);
  }

  async putSnapshot(input: SnapshotInput): Promise<ArtifactMetadata> {
    this.authorize(input);
    const snapshot = TurnWorkspaceSnapshotSchema.parse(input.snapshot);
    this.assertSnapshot(snapshot, snapshot.phase);
    return this.write(
      snapshot.phase === "start" ? "snapshot_start" : "snapshot_terminal",
      JSON.stringify(snapshot),
      snapshot.capturedAt,
      [],
    );
  }

  async putTurnDiff(input: DiffInput): Promise<ArtifactMetadata> {
    this.authorize(input);
    if (input.diff.patch.length > MAX_RUNTIME_TURN_ARTIFACT_BYTES) {
      throw new Error("Canonical turn diff exceeds the artifact size limit");
    }
    const diff = TurnDiffPayloadSchema.parse(input.diff);
    if (diff.turnId !== this.owner.turnId) {
      throw new Error("Canonical diff differs from admitted turn");
    }
    this.assertSnapshot(diff.startSnapshot, "start");
    this.assertSnapshot(diff.terminalSnapshot, "terminal");
    return this.write(
      "turn_diff",
      JSON.stringify(diff),
      diff.terminalSnapshot.capturedAt,
      diff.files,
    );
  }

  private assertSnapshot(
    snapshot: TurnWorkspaceSnapshot,
    phase: TurnWorkspaceSnapshot["phase"],
  ): void {
    if (
      snapshot.turnId !== this.owner.turnId ||
      snapshot.snapshotKey !== this.owner.turnId ||
      snapshot.phase !== phase
    ) {
      throw new Error("Canonical snapshot differs from admitted turn or phase");
    }
    const resume = snapshot.resumeSnapshotRef;
    if (
      resume &&
      (phase !== "terminal" ||
        resume.userId !== this.owner.userId ||
        resume.workspaceId !== this.owner.workspaceId ||
        resume.threadId !== this.owner.threadId ||
        resume.sourceRunId !== this.owner.runId ||
        resume.sourceTurnId !== this.owner.turnId ||
        resume.sourceRunAttemptId !== this.owner.runAttemptId ||
        resume.terminalTreeSha !== snapshot.treeId)
    ) {
      throw new Error("Resume snapshot differs from admitted attempt");
    }
  }

  private async write(
    role: ArtifactRole,
    payload: string,
    createdAt: string,
    changedFiles: ArtifactChangedFile[],
  ): Promise<ArtifactMetadata> {
    const bucket = this.env.EDIT_ARTIFACTS;
    if (!bucket) throw new Error("Canonical artifact storage is unavailable");

    const { threadId, runId, workspaceId, turnId, runAttemptId } = this.owner;
    const artifactId = `art_${await sha256Hex(JSON.stringify([this.owner, role]))}`;
    const payloadRef = await new EditArtifactObjectStore(
      bucket,
    ).writeRuntimeTurnArtifact({
      ...this.owner,
      artifactId,
      role,
      checkoutId: this.checkoutId,
      checkoutGeneration: this.checkoutGeneration,
      scopeSha256: await sha256Hex(this.checkoutScope),
      payload,
    });
    const isDiff = role === "turn_diff";

    return ArtifactMetadataSchema.parse({
      artifactId,
      threadId,
      runId,
      workspaceId,
      itemId: null,
      kind: isDiff ? "diff" : "workspace_snapshot",
      label: isDiff ? "Turn changes" : "Turn workspace snapshot",
      payloadRef,
      changedFiles,
      metadata: { role, turnId, runAttemptId },
      createdAt,
      // The kernel assigns the sequence on the enclosing lifecycle event.
      eventSequence: 0,
    });
  }

  private authorize({ ownership, access }: SnapshotInput | DiffInput): void {
    const { userId, workspaceId, threadId, runId } = this.owner;
    if (
      ownership.createdBy !== userId ||
      ownership.workspaceId !== workspaceId ||
      ownership.threadId !== threadId ||
      ownership.runId !== runId ||
      access.userId !== userId ||
      access.workspaceId !== workspaceId ||
      access.threadId !== threadId ||
      access.runId !== runId
    ) {
      throw new Error("Artifact access differs from admitted ownership");
    }
  }
}
