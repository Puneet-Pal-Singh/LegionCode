import {
  ResumeWorkspaceSnapshotRefSchema,
  ThreadInputConfigurationSchema,
  type ResumeWorkspaceSnapshotRef,
  type ThreadInputConfiguration,
} from "@repo/platform-protocol";
import { ResumeWorkspaceSnapshotStore } from "../../runtime/task-workspaces/ResumeWorkspaceSnapshotStore";
import type { Env } from "../../types/ai";
import { withTurnAdmissionRepository } from "./TurnAdmissionPersistenceFactory";

export interface ResumeTurnInput {
  readonly userId: string;
  readonly sessionId: string;
  readonly threadId: string;
  readonly workspaceId: string;
  readonly expectedTurnId: string;
  readonly expectedRunAttemptId: string;
  readonly terminalSequence: number;
  readonly clientCommandId: string;
  readonly configuration?: ThreadInputConfiguration;
  readonly turnId: string;
  readonly runAttemptId: string;
  readonly runId: string;
}

export interface ResumedTurn {
  readonly admission: import("@repo/persistence").TurnAdmissionRecord;
  readonly run: import("@repo/persistence").RunRecord;
  readonly originalPromptId: string;
  readonly prompt: { readonly text: string; readonly parts: import("@repo/persistence").InterruptedTurnTarget["prompt"]["parts"] };
  readonly configuration: {
    readonly mode: string;
    readonly providerId: string | null;
    readonly modelId: string | null;
    readonly branch: string | null;
    readonly reasoningEffort?: ThreadInputConfiguration["reasoningEffort"];
    readonly productMode?: ThreadInputConfiguration["productMode"];
    readonly harnessId?: ThreadInputConfiguration["harnessId"];
  };
  readonly resumeSnapshot: ResumeWorkspaceSnapshotRef;
  readonly workspacePatch: string;
}

export class ResumeTurnError extends Error {
  constructor(message: string, readonly code: string, readonly status = 409) {
    super(message);
    this.name = "ResumeTurnError";
  }
}

/** Admits a new logical turn for an exact interrupted turn and its captured workspace. */
export class ResumeTurnService {
  constructor(private readonly env: Env) {}

  async resume(input: ResumeTurnInput): Promise<ResumedTurn> {
    if (!this.env.EDIT_ARTIFACTS) {
      throw new ResumeTurnError("Workspace resume artifacts are unavailable", "resume_snapshot_unavailable", 503);
    }
    if (!input.clientCommandId.trim() || input.clientCommandId.length > 200) {
      throw new ResumeTurnError("A stable resume command ID is required", "client_command_id_invalid", 400);
    }
    if (!Number.isSafeInteger(input.terminalSequence) || input.terminalSequence < 1) {
      throw new ResumeTurnError("The interrupted turn terminal sequence is invalid", "terminal_sequence_invalid", 400);
    }
    let explicitConfiguration: ThreadInputConfiguration;
    try {
      explicitConfiguration = ThreadInputConfigurationSchema.parse(input.configuration ?? {});
    } catch {
      throw new ResumeTurnError("The resume configuration is invalid", "resume_configuration_invalid", 400);
    }

    const target = await withTurnAdmissionRepository(this.env, (repository) =>
      repository.getInterruptedTarget({
        sessionId: input.sessionId,
        userId: input.userId,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        turnId: input.expectedTurnId,
        runAttemptId: input.expectedRunAttemptId,
        terminalSequence: input.terminalSequence,
        clientMessageId: input.clientCommandId,
      }),
    );
    if (!target) {
      throw new ResumeTurnError("The interrupted turn is no longer the current resumable turn", "resume_target_conflict");
    }

    const resumeSnapshot = parseResumeSnapshotArtifact(target.snapshotEvent, target.resumeArtifactEvent);
    if (
      resumeSnapshot.userId !== input.userId ||
      resumeSnapshot.workspaceId !== input.workspaceId ||
      resumeSnapshot.threadId !== input.threadId ||
      resumeSnapshot.sourceRunId !== target.admission.runId ||
      resumeSnapshot.sourceTurnId !== target.admission.turnId ||
      resumeSnapshot.sourceRunAttemptId !== target.admission.runAttemptId
    ) {
      throw new ResumeTurnError("The captured workspace snapshot does not belong to the interrupted turn", "resume_snapshot_scope_conflict");
    }
    let workspacePatch: string;
    try {
      workspacePatch = await new ResumeWorkspaceSnapshotStore(this.env.EDIT_ARTIFACTS).read(
        resumeSnapshot,
        { userId: input.userId, workspaceId: input.workspaceId, threadId: input.threadId },
      );
    } catch {
      throw new ResumeTurnError("The captured workspace snapshot failed ownership or integrity validation", "resume_snapshot_unavailable");
    }
    const configuration: {
      mode: string;
      providerId: string | null;
      modelId: string | null;
      branch: string | null;
      reasoningEffort?: ThreadInputConfiguration["reasoningEffort"];
      productMode?: ThreadInputConfiguration["productMode"];
      harnessId?: ThreadInputConfiguration["harnessId"];
    } = {
      ...explicitConfiguration,
      mode: explicitConfiguration.mode ?? target.run.mode,
      providerId: explicitConfiguration.providerId ?? target.run.providerId,
      modelId: explicitConfiguration.modelId ?? target.run.modelId,
      branch: target.run.branch,
    };
    const fingerprint = await buildResumeFingerprint({
      sourceTurnId: target.admission.turnId,
      sourceRunAttemptId: target.admission.runAttemptId,
      terminalSequence: input.terminalSequence,
      originalPromptId: target.originalPromptId,
      sourceRunId: target.run.id,
      explicitConfiguration,
      inheritedConfiguration: {
        mode: target.run.mode,
        providerId: target.run.providerId,
        modelId: target.run.modelId,
        branch: target.run.branch,
      },
      snapshotDigest: resumeSnapshot.patchSha256,
    });
    const resumed = await withTurnAdmissionRepository(this.env, async (repository) =>
      await repository.admitContinuation({
        sessionId: input.sessionId,
        clientMessageId: input.clientCommandId,
        threadId: input.threadId,
        turnId: input.turnId,
        runAttemptId: input.runAttemptId,
        runId: input.runId,
        requestFingerprint: fingerprint,
        userId: input.userId,
        workspaceId: input.workspaceId,
        taskId: target.run.taskId,
        mode: configuration.mode,
        providerId: configuration.providerId,
        modelId: configuration.modelId,
        branch: configuration.branch,
        runStatus: "running",
        continuationOfTurnId: target.admission.turnId,
        originalPromptId: target.originalPromptId,
        continuationTerminalSequence: input.terminalSequence,
      }),
    );
    return {
      admission: resumed.admission,
      run: resumed.run,
      originalPromptId: target.originalPromptId,
      prompt: target.prompt,
      configuration,
      resumeSnapshot,
      workspacePatch,
    };
  }
}

function parseResumeSnapshotArtifact(
  rawSnapshotEvent: import("@repo/shared-types").JsonValue,
  rawArtifactEvent: import("@repo/shared-types").JsonValue,
): ResumeWorkspaceSnapshotRef {
  const snapshotEvent = asRecord(rawSnapshotEvent);
  const snapshotBundle = asRecord(asRecord(snapshotEvent.payload).snapshot);
  const snapshotPayload = asRecord(snapshotBundle.snapshot);
  const rawRef = snapshotPayload.resumeSnapshotRef;
  const artifactEvent = asRecord(rawArtifactEvent);
  const artifact = asRecord(asRecord(artifactEvent.payload).artifact);
  const payloadRef = asRecord(artifact.payloadRef);
  const metadata = asRecord(artifact.metadata);
  try {
    const ref = ResumeWorkspaceSnapshotRefSchema.parse(rawRef);
    if (
      artifact.artifactId !== ref.artifactId || payloadRef.objectKey !== ref.payloadObjectKey ||
      artifact.workspaceId !== ref.workspaceId || artifact.threadId !== ref.threadId ||
      metadata.sourceUserId !== ref.userId || metadata.sourceRunId !== ref.sourceRunId ||
      metadata.sourceTurnId !== ref.sourceTurnId || metadata.sourceRunAttemptId !== ref.sourceRunAttemptId ||
      metadata.baseSnapshotId !== ref.baseSnapshotId || metadata.baseCommitSha !== ref.baseCommitSha ||
      metadata.terminalTreeSha !== ref.terminalTreeSha || metadata.patchSha256 !== ref.patchSha256 ||
      metadata.byteLength !== ref.byteLength || payloadRef.sha256 !== ref.patchSha256 || payloadRef.sizeBytes !== ref.byteLength
    ) throw new Error("Captured workspace snapshot artifact does not match its lifecycle reference");
    return ref;
  } catch {
    throw new ResumeTurnError("The interrupted turn has no valid captured workspace snapshot", "resume_snapshot_unavailable");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function buildResumeFingerprint(value: Record<string, unknown>): Promise<string> {
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
