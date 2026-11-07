import { createHash } from "node:crypto";
import { LeaseIdSchema, type HarnessSelection, type LeaseId, type LifecycleEvent } from "@repo/platform-protocol";
import type { TurnAdmission } from "@repo/platform-protocol/conversation";
import type { LocalPersistence } from "@repo/event-store/local";
import type { LocalWorkspaceService } from "../local-workspace.js";

/** The exclusive SQLite writer admits local work. Its canonical admission is the
 * durable checkout owner; release is derived from canonical terminal + immutable
 * artifact evidence, never a second lease file or process-local success flag.
 */
export class LocalWorkspaceLease {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly persistence: LocalPersistence, private readonly workspace: LocalWorkspaceService) {}
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
        if (prior && prior.run.executionCapability !== "conversation") await this.assertSettled(prior);
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
    await this.assertCanonicalSettlement(admission);
    const binding = await this.persistence.harnessBindings.read({ userId: admission.run.userId,
      turnId: admission.turn.id, runAttemptId: admission.runAttemptId });
    if (binding?.attachment) {
      throw new Error("Local checkout lease retains its external stream until canonical integrity retirement is verified");
    }
  }

  /** Canonical terminal/artifact precondition for the owner-driven release path.
   * Passing this check alone never retires an external stream or releases a lease.
   */
  async assertCanonicalSettlement(admission: TurnAdmission): Promise<void> {
    const history = await this.history(admission);
    const terminal = history.at(-1);
    if (!terminal || !["turn.completed", "turn.failed", "turn.interrupted"].includes(terminal.type)) {
      throw new Error("Local checkout is retained by an unsettled admitted attempt");
    }
    const events = await this.persistence.events.listAll();
    const artifacts = events.filter((event) => event.type === "artifact.created" && event.runId === admission.run.id);
    const hasStartEvidence = history.some((event) => event.type === "workspace.snapshot_captured") || artifacts.length > 0;
    const binding = await this.persistence.harnessBindings.read({ userId: admission.run.userId,
      turnId: admission.turn.id, runAttemptId: admission.runAttemptId });
    // A learned attachment invalidates the pre-start exemption even when start
    // evidence is missing. Missing evidence must retain, never release, ownership.
    if (!hasStartEvidence && !binding?.attachment && terminal.type !== "turn.completed") return;
    const snapshot = artifacts.some((event) => event.type === "artifact.created" &&
      event.payload.artifact.metadata.turnId === admission.turn.id && event.payload.artifact.metadata.phase === "snapshot:terminal");
    const diff = artifacts.some((event) => event.type === "artifact.created" &&
      event.payload.artifact.metadata.turnId === admission.turn.id && event.payload.artifact.metadata.role === "turn_diff");
    if (!snapshot || !diff) throw new Error("Local checkout lease retains ownership until immutable artifact settlement");
  }
  private async history(admission: TurnAdmission): Promise<LifecycleEvent[]> {
    const history: LifecycleEvent[] = [];
    let afterSequence: number | null = null;
    for (let page = 0; page < 100; page += 1) {
      const replay = await this.persistence.lifecycleEvents.replay({ turnId: admission.turn.id, afterSequence, limit: 1000 });
      for (const event of replay.events) {
        if (event.threadId !== admission.run.threadId || event.runAttemptId !== admission.runAttemptId) throw new Error("Local lease replay identity mismatch");
        history.push(event);
      }
      if (replay.nextSequence === null || replay.nextSequence === afterSequence) return history;
      afterSequence = replay.nextSequence;
    }
    throw new Error("Local lease replay exceeds its explicit recovery bound");
  }
}
