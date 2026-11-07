import {
  ArtifactMetadataSchema,
  TurnWorkspaceSnapshotSchema,
  type Run,
  type RunAttemptId,
  type TurnId,
} from "@repo/platform-protocol";
import type { RuntimeTurnArtifactPort } from "@repo/runtime-kernel";
import type { Env } from "../../types/ai";
import type { IssuedTaskCheckout } from "../../runtime/task-workspaces/TaskCheckoutIssuer";
import { EditArtifactCaptureService } from "./EditArtifactCaptureService";
import { EditArtifactObjectStore } from "./EditArtifactObjectStore";
import { sha256Hex } from "./EditArtifactStorageBackend";

/** Narrow kernel adapter over the existing artifact owner/writers/readback. */
export class CanonicalRuntimeTurnArtifactPort implements RuntimeTurnArtifactPort {
  constructor(
    private readonly env: Env,
    private readonly scope: {
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
    },
  ) {}

  async putSnapshot(
    input: Parameters<RuntimeTurnArtifactPort["putSnapshot"]>[0],
  ) {
    this.authorize(input);
    const snapshot = TurnWorkspaceSnapshotSchema.parse(input.snapshot);
    if (snapshot.turnId !== this.scope.turnId || !this.env.EDIT_ARTIFACTS)
      throw new Error("Canonical snapshot scope/storage unavailable");
    const payload = JSON.stringify(snapshot),
      sha256 = await sha256Hex(payload);
    const artifactId = `art_${(await sha256Hex(`${this.scope.runAttemptId}:${snapshot.phase}`)).slice(0, 48)}`;
    const stored = await new EditArtifactObjectStore(
      this.env.EDIT_ARTIFACTS,
    ).writeRuntimeSnapshot({
      userId: this.scope.userId,
      workspaceId: this.scope.workspaceId,
      runId: this.scope.run.id,
      artifactId,
      payload,
      sha256,
    });
    return ArtifactMetadataSchema.parse({
      artifactId,
      threadId: this.scope.run.threadId,
      runId: this.scope.run.id,
      workspaceId: this.scope.run.workspaceId,
      itemId: null,
      kind: "workspace_snapshot",
      label: "Turn workspace snapshot",
      payloadRef: {
        backend: "r2",
        objectKey: stored.key,
        uri: null,
        contentType: "application/json",
        sizeBytes: stored.byteLength,
        sha256,
      },
      changedFiles: [],
      metadata: {
        role: `snapshot_${snapshot.phase}`,
        turnId: snapshot.turnId,
        runAttemptId: this.scope.runAttemptId,
      },
      createdAt: snapshot.capturedAt,
      eventSequence: 0,
    });
  }

  async putTurnDiff(
    input: Parameters<RuntimeTurnArtifactPort["putTurnDiff"]>[0],
  ) {
    this.authorize(input);
    const { run, issued } = this.scope;
    const artifact = await new EditArtifactCaptureService(
      this.env,
    ).persistCanonicalTurnDiff({
      userId: this.scope.userId,
      workspaceId: this.scope.workspaceId,
      sessionId: this.scope.sessionId,
      runId: run.id,
      threadId: run.threadId,
      turnId: this.scope.turnId,
      runAttemptId: this.scope.runAttemptId,
      workspaceScope: issued.workspaceScope,
      executionSession: issued.executionSession,
      repoOwner: this.scope.repoOwner,
      repoName: this.scope.repoName,
      repoUrl: this.scope.repoUrl,
      changedFiles: input.diff.files.map((file) => ({
        ...file,
        isStaged: false,
      })),
      diff: input.diff,
    });
    return ArtifactMetadataSchema.parse({
      artifactId: `art_${artifact.id}`,
      threadId: run.threadId,
      runId: run.id,
      workspaceId: run.workspaceId,
      itemId: null,
      kind: "diff",
      label: "Turn changes",
      payloadRef: {
        backend: "r2",
        objectKey: artifact.r2ObjectKey,
        uri: null,
        contentType: artifact.contentType ?? "application/vnd.git.patch",
        sizeBytes:
          artifact.sizeBytes ??
          new TextEncoder().encode(input.diff.patch).byteLength,
        sha256: artifact.sha256 ?? (await sha256Hex(input.diff.patch)),
      },
      changedFiles: input.diff.files,
      metadata: {
        role: "turn_diff",
        artifactRecordId: artifact.id,
        turnId: this.scope.turnId,
        runAttemptId: this.scope.runAttemptId,
      },
      createdAt: artifact.createdAt,
      eventSequence: 0,
    });
  }

  private authorize(
    input:
      | Parameters<RuntimeTurnArtifactPort["putSnapshot"]>[0]
      | Parameters<RuntimeTurnArtifactPort["putTurnDiff"]>[0],
  ): void {
    const run = this.scope.run;
    if (
      input.ownership.createdBy !== run.userId ||
      input.ownership.workspaceId !== run.workspaceId ||
      input.ownership.threadId !== run.threadId ||
      input.ownership.runId !== run.id ||
      input.access.userId !== run.userId ||
      input.access.workspaceId !== run.workspaceId ||
      input.access.threadId !== run.threadId ||
      input.access.runId !== run.id
    )
      throw new Error("Artifact access differs from admitted ownership");
  }
}
