import { createHash } from "node:crypto";
import { ArtifactMetadataSchema, JsonRecordSchema, LeaseIdSchema, TurnWorkspaceSnapshotSchema,
  type EventId, type HarnessSelection, type LeaseId, type LifecycleEvent, type TurnId } from "@repo/platform-protocol";
import type { TurnAdmission } from "@repo/platform-protocol/conversation";
import type { LocalPersistence } from "@repo/event-store/local";
import type { LocalWorkspaceService } from "../local-workspace.js";

/** The exclusive SQLite writer admits local work. Its canonical admission is the
 * durable checkout owner; release is derived from canonical terminal + immutable
 * artifact evidence, never a second lease file or process-local success flag.
 */
export class LocalWorkspaceLease {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly persistence: LocalPersistence, private readonly workspace: LocalWorkspaceService,
    private readonly hasExecutionOwner: (turnId: TurnId) => boolean) {}
  leaseId(admission: TurnAdmission): LeaseId {
    const key = `${admission.run.workspaceId}:${admission.runAttemptId}`;
    return LeaseIdSchema.parse(`lease_${createHash("sha256").update(key).digest("hex").slice(0, 32)}`);
  }
  admit(candidate: TurnAdmission): ReturnType<LocalPersistence["turnAdmissions"]["admit"]> {
    const operation = this.queue.then(async () => {
      await this.workspace.requireExecutionGrant(candidate.run.workspaceId);
      const priorRequest = await this.persistence.turnAdmissions.findByRequest(candidate.run.threadId, candidate.clientRequestId);
      if (priorRequest) return this.persistence.turnAdmissions.admit(candidate);
      const events = await this.persistence.events.listAll();
      const turns = events.filter((event) => event.type === "turn.started" && event.workspaceId === candidate.run.workspaceId);
      for (const event of turns) {
        if (event.type !== "turn.started" || event.payload.turn.id === candidate.turn.id) continue;
        const prior = await this.persistence.turnAdmissions.getByTurn(event.payload.turn.id);
        if (prior && prior.run.executionCapability !== "conversation") {
          // A retirement commit may have succeeded with an unknown return value.
          // Do not bypass the retained runtime owner merely because replay now
          // shows a cleared attachment. That owner still requires reconciliation.
          if (this.hasExecutionOwner(prior.turn.id)) throw new Error("Local checkout retains its active execution owner");
          await this.assertSettled(prior);
        }
      }
      return this.persistence.turnAdmissions.admit(candidate);
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }
  async assertActive(input: { readonly selection: HarnessSelection; readonly leaseId: LeaseId; readonly filesystemRoot: string }): Promise<void> {
    const admission = await this.persistence.turnAdmissions.getByTurn(input.selection.turnId);
    if (!admission || admission.runAttemptId !== input.selection.runAttemptId || admission.run.id !== input.selection.runId ||
        admission.run.workspaceId !== input.selection.workspaceId || admission.run.userId !== input.selection.userId ||
        this.leaseId(admission) !== input.leaseId) throw new Error("Local checkout lease does not match canonical admission");
    const grant = await this.workspace.requireExecutionGrant(admission.run.workspaceId);
    if (grant.path !== input.filesystemRoot) throw new Error("Local checkout lease root is no longer granted");
    const history = await this.history(admission);
    if (history.some((event) => ["turn.completed", "turn.failed", "turn.interrupted"].includes(event.type))) {
      throw new Error("Local checkout lease belongs to a terminal turn");
    }
  }
  async assertSettled(admission: TurnAdmission): Promise<void> {
    const terminalEventId = await this.assertArtifactsCommitted(admission);
    const scope = { userId: admission.run.userId, turnId: admission.turn.id, runAttemptId: admission.runAttemptId };
    const binding = await this.persistence.harnessBindings.read(scope);
    if (!binding) return; // No frozen claim: only the guarded pre-host path can settle.
    const proof = await this.persistence.readAttachmentRetirement(scope);
    if (proof.status !== "verified_retirement" ||
        proof.selection.selectionJson !== binding.selection.selectionJson ||
        proof.selection.runId !== admission.run.id || proof.selection.threadId !== admission.run.threadId ||
        proof.selection.workspaceId !== admission.run.workspaceId || proof.selection.userId !== admission.run.userId ||
        proof.selection.turnId !== admission.turn.id || proof.selection.runAttemptId !== admission.runAttemptId ||
        proof.retirements.length === 0 || proof.retirements.some((receipt) => receipt.terminalEventId !== terminalEventId)) {
      throw new Error("Local checkout retains its frozen claim until durable physical retirement is verified");
    }
  }

  /** Trusted composition supplies the existing CORE release and SQLite retirement.
   * Success is re-read from validated durable receipts, including unknown commits.
   */
  async settleAfterRelease(admission: TurnAdmission, release: () => Promise<void>): Promise<void> {
    await this.assertArtifactsCommitted(admission);
    await release();
    await this.assertSettled(admission);
  }

  /** Canonical terminal/artifact precondition for the owner-driven release path.
   * Passing this check alone never retires an external stream or releases a lease.
   */
  async assertArtifactsCommitted(admission: TurnAdmission): Promise<EventId> {
    const history = await this.history(admission);
    const terminal = history.at(-1);
    if (!terminal || !["turn.completed", "turn.failed", "turn.interrupted"].includes(terminal.type)) {
      throw new Error("Local checkout is retained by an unsettled admitted attempt");
    }
    const events = await this.persistence.events.listAll();
    const artifacts = events.filter((event) => event.type === "artifact.created").filter((event) =>
      event.runId === admission.run.id && event.threadId === admission.run.threadId &&
      event.workspaceId === admission.run.workspaceId && event.payload.artifact.metadata.createdBy === admission.run.userId &&
      event.payload.artifact.payloadRef.backend === "local_blob" && event.payload.artifact.payloadRef.sha256 !== null &&
      event.payload.artifact.payloadRef.objectKey === `sha256:${event.payload.artifact.payloadRef.sha256}`);
    const hasStartEvidence = history.some((event) => event.type === "workspace.snapshot_captured") || artifacts.length > 0;
    const binding = await this.persistence.harnessBindings.read({ userId: admission.run.userId,
      turnId: admission.turn.id, runAttemptId: admission.runAttemptId });
    // A learned attachment invalidates the pre-start exemption even when start
    // evidence is missing. Missing evidence must retain, never release, ownership.
    if (!hasStartEvidence && !binding && terminal.type !== "turn.completed") return terminal.eventId;
    const snapshot = artifacts.find((event) => event.payload.artifact.kind === "workspace_snapshot" &&
      event.payload.artifact.metadata.turnId === admission.turn.id && event.payload.artifact.metadata.phase === "snapshot:terminal");
    const diff = artifacts.find((event) => event.payload.artifact.kind === "diff" &&
      event.payload.artifact.metadata.turnId === admission.turn.id && event.payload.artifact.metadata.role === "turn_diff");
    if (!snapshot || !diff) throw new Error("Local checkout lease retains ownership until immutable artifact settlement");
    const snapshotReferenced = history.some((event) => {
      if (event.type !== "workspace.snapshot_captured") return false;
      const wrapper = JsonRecordSchema.safeParse(event.payload.snapshot);
      if (!wrapper.success) return false;
      const captured = TurnWorkspaceSnapshotSchema.safeParse(wrapper.data.snapshot);
      const artifact = ArtifactMetadataSchema.safeParse(wrapper.data.artifact);
      return captured.success && captured.data.turnId === admission.turn.id && captured.data.phase === "terminal" &&
        artifact.success && JSON.stringify(artifact.data) === JSON.stringify(snapshot.payload.artifact);
    });
    const diffReferenced = history.some((event) => {
      if (event.type !== "artifact.created") return false;
      const artifact = ArtifactMetadataSchema.safeParse(event.payload.artifact);
      return artifact.success && JSON.stringify(artifact.data) === JSON.stringify(diff.payload.artifact);
    });
    if (!snapshotReferenced || !diffReferenced) throw new Error("Local terminal artifacts have no matching canonical lifecycle references");
    return terminal.eventId;
  }
  private async history(admission: TurnAdmission): Promise<LifecycleEvent[]> {
    const history: LifecycleEvent[] = [];
    let afterSequence: number | null = null;
    for (let page = 0; page < 100; page += 1) {
      const replay = await this.persistence.lifecycleEvents.replay({ turnId: admission.turn.id, afterSequence, limit: 1000 });
      for (const event of replay.events) {
        if (event.turnId !== admission.turn.id || event.threadId !== admission.run.threadId ||
            event.runAttemptId !== admission.runAttemptId || event.producer.id !== admission.run.workerId ||
            event.sequence !== history.length + 1) throw new Error("Local lease replay identity or admitted producer mismatch");
        history.push(event);
      }
      if (replay.nextSequence === null) return history;
      if (!replay.events.length || !Number.isSafeInteger(replay.nextSequence) ||
          replay.nextSequence <= (afterSequence ?? 0) || replay.nextSequence !== history.at(-1)?.sequence) {
        throw new Error("Local lease replay cursor did not advance over its exact canonical page");
      }
      afterSequence = replay.nextSequence;
    }
    throw new Error("Local lease replay exceeds its explicit recovery bound");
  }
}
