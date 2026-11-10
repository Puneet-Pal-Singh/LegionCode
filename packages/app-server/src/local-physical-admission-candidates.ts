import { isDeepStrictEqual } from "node:util";
import { TurnAdmissionSchema, type TurnAdmission } from "@repo/platform-protocol";
import type { LocalPersistence } from "@repo/event-store/local";
import {
  HarnessPreOpeningSettlementResultSchema,
  type HarnessPreOpeningSettlement,
  type LocalNativeResourceSettlement,
} from "@repo/event-store";
import type { LocalTurnAttemptIdentity } from "@legioncode/execution-engine/runtime/desktop/LocalReadOnlyTurnExecutor";
import { verifyLocalNativePredecessorSettlement } from "./local-native-settlement.js";
import { readLocalTurnArtifactPublication } from "./local-turn-artifact-publication.js";
import type { LocalWorkspaceExecutionBinding, LocalWorkspaceService } from "./local-workspace.js";
import { LocalWorkspaceWriterLeaseError, type LocalWorkspaceWriterLease, type LocalWorkspaceWriterLeaseOwner } from "./local-workspace-writer-lease.js";

type Persistence = Pick<LocalPersistence, "turnAdmissions" | "lifecycleEvents" | "turnArtifacts" | "readHarnessPreOpeningSettlement">;
type AdmissionResult = Awaited<ReturnType<LocalPersistence["turnAdmissions"]["admit"]>>;

export type LocalPhysicalAdmissionPublication =
  | { readonly newlyAdmitted: false; readonly admission: TurnAdmission }
  | { readonly newlyAdmitted: true; readonly admission: TurnAdmission;
      readonly disposition: "execution";
      readonly binding: LocalWorkspaceExecutionBinding; readonly lease: LocalWorkspaceWriterLease }
  | { readonly newlyAdmitted: true; readonly admission: TurnAdmission;
      readonly disposition: "settlement_required";
      readonly settleBeforeDispatch: (input: LocalPhysicalAdmissionSettlement) => Promise<boolean> };

export type LocalPhysicalAdmissionSettlement = {
  /** The existing canonical runtime/061 reservation owner settles interruption.
   * This callback grants no execution or physical release authority. */
  readonly settleCanonical: (admission: TurnAdmission) => Promise<void>;
};

/** Private original-resource reservation. The caller retains this object before
 * awaiting ready(), and keeps it on every unknown acquisition/publication result. */
export interface LocalPhysicalAdmissionCandidate {
  ready(): Promise<void>;
  verifyNativePredecessor(predecessor: TurnAdmission): Promise<LocalNativeResourceSettlement>;
  /** Invoke the existing canonical admission owner at most once. Only an exact,
   * positively newly-admitted receipt exposes the original execution authority. */
  publish(publishAdmission: (candidate: TurnAdmission) => Promise<AdmissionResult>): Promise<LocalPhysicalAdmissionPublication>;
  /** Permanently fences publication/adoption, drains both original promises,
   * then asks the same writer entry to verify canonical absence before release. */
  discardUnadmitted(): Promise<boolean>;
  settleBeforeDispatch(input: LocalPhysicalAdmissionSettlement): Promise<boolean>;
}

export interface LocalPhysicalAdmissionCandidates {
  /** Synchronous reservation; deferred acquisition cannot start before return. */
  acquire(input: { readonly candidate: TurnAdmission; readonly signal: AbortSignal }): LocalPhysicalAdmissionCandidate;
}

/** Trusted Desktop supplies the SAME writer owner used by Native and commits.
 * No independent fence namespace, admission store or attempt registry is created. */
export function createLocalPhysicalAdmissionCandidates(options: {
  readonly persistence: Persistence;
  readonly workspaces: LocalWorkspaceService;
  readonly leases: LocalWorkspaceWriterLeaseOwner;
}): LocalPhysicalAdmissionCandidates {
  return Object.freeze({
    acquire: (input: { readonly candidate: TurnAdmission; readonly signal: AbortSignal }) =>
      new PhysicalAdmissionCandidate(options, input),
  });
}

class PhysicalAdmissionCandidate implements LocalPhysicalAdmissionCandidate {
  private readonly admission: TurnAdmission;
  private readonly attempt: LocalTurnAttemptIdentity;
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal;
  private readonly acquisition: Promise<void>;
  private publication: Promise<LocalPhysicalAdmissionPublication> | undefined;
  private discard: Promise<boolean> | undefined;
  private settlement: Promise<boolean> | undefined;
  private binding: LocalWorkspaceExecutionBinding | undefined;
  private lease: LocalWorkspaceWriterLease | undefined;
  private acquisitionWasUnused = false;
  private bindingWasStarted = false;
  private fenced = false;
  private adopted = false;
  private knownAdmission = false;

  constructor(private readonly options: Parameters<typeof createLocalPhysicalAdmissionCandidates>[0], input: {
    readonly candidate: TurnAdmission; readonly signal: AbortSignal;
  }) {
    this.admission = TurnAdmissionSchema.parse(input.candidate);
    if (this.admission.run.executionCapability !== "repository") throw unavailable();
    this.attempt = Object.freeze({
      workspaceId: this.admission.run.workspaceId, threadId: this.admission.run.threadId,
      runId: this.admission.run.id, turnId: this.admission.turn.id, runAttemptId: this.admission.runAttemptId,
    });
    this.signal = AbortSignal.any([input.signal, this.controller.signal]);
    // Register the original before invoking either asynchronous resource owner.
    this.acquisition = Promise.resolve().then(() => this.acquireOriginal());
    void this.acquisition.catch(() => undefined);
  }

  async ready(): Promise<void> {
    await this.acquisition;
    this.assertAccepting();
  }

  async verifyNativePredecessor(predecessor: TurnAdmission): Promise<LocalNativeResourceSettlement> {
    await this.ready();
    const proof = await verifyLocalNativePredecessorSettlement({
      persistence: this.options.persistence, predecessor, successor: this.admission, lease: this.lease!,
    });
    this.assertAccepting();
    return proof;
  }

  publish(publishAdmission: (candidate: TurnAdmission) => Promise<AdmissionResult>): Promise<LocalPhysicalAdmissionPublication> {
    if (this.fenced || this.publication || this.adopted) return Promise.reject(unavailable());
    // Store this entire operation, including validation, before invoking the
    // publisher. Discard must drain this original, never a replacement lookup.
    this.publication = Promise.resolve().then<LocalPhysicalAdmissionPublication>(async () => {
      await this.ready();
      this.assertAccepting();
      let result: AdmissionResult;
      try {
        result = await publishAdmission(this.admission);
      } catch (error) {
        // Unknown delivery can only reconcile to cleanup, never execution.
        if (await this.readExactCandidate()) return this.requireSettlement();
        throw error;
      }
      const admission = TurnAdmissionSchema.parse(result.admission);
      if (result.newlyAdmitted === false) {
        const byRequest = await this.options.persistence.turnAdmissions.findByRequest(
          this.admission.run.threadId, this.admission.clientRequestId,
        );
        const byTurn = await this.options.persistence.turnAdmissions.getByTurn(admission.turn.id);
        if (!sameRequest(this.admission, admission) || !byRequest || !byTurn ||
            !isDeepStrictEqual(TurnAdmissionSchema.parse(byRequest), admission) ||
            !isDeepStrictEqual(TurnAdmissionSchema.parse(byTurn), admission)) throw unavailable();
        return { newlyAdmitted: false, admission };
      }
      if (result.newlyAdmitted !== true || !isDeepStrictEqual(admission, this.admission)) throw unavailable();
      if (!(await this.readExactCandidate())) throw unavailable();
      if (this.fenced || this.signal.aborted) return this.requireSettlement();
      try {
        await this.lease!.assertCurrent();
        this.assertAccepting();
      } catch {
        return this.requireSettlement();
      }
      this.adopted = true;
      return { newlyAdmitted: true, disposition: "execution", admission, binding: this.binding!, lease: this.lease! };
    });
    void this.publication.catch(() => undefined);
    return this.publication;
  }

  discardUnadmitted(): Promise<boolean> {
    if (this.adopted) return Promise.resolve(false);
    this.fenced = true;
    this.controller.abort("Physical admission candidate is closing");
    this.discard ??= this.discardOriginal();
    return this.discard;
  }

  settleBeforeDispatch(input: LocalPhysicalAdmissionSettlement): Promise<boolean> {
    if (this.adopted) return Promise.resolve(false);
    this.fenced = true;
    this.controller.abort("Known admission is settling without dispatch");
    this.settlement ??= this.settleOriginal(input);
    return this.settlement;
  }

  private requireSettlement(): LocalPhysicalAdmissionPublication {
    this.fenced = true;
    return {
      newlyAdmitted: true, disposition: "settlement_required", admission: this.admission,
      settleBeforeDispatch: (input) => this.settleBeforeDispatch(input),
    };
  }

  private async readExactCandidate(): Promise<boolean> {
    const saved = await this.options.persistence.turnAdmissions.getByTurn(this.admission.turn.id);
    if (!saved || !isDeepStrictEqual(TurnAdmissionSchema.parse(saved), this.admission)) return false;
    this.knownAdmission = true;
    return true;
  }

  private async acquireOriginal(): Promise<void> {
    this.assertAccepting();
    this.bindingWasStarted = true;
    this.binding = await this.options.workspaces.bindForExecution(this.attempt.workspaceId);
    // A completed binding is ours, but no writer operation has been invoked yet.
    this.acquisitionWasUnused = true;
    this.assertAccepting();
    this.binding.assertCurrent();
    this.acquisitionWasUnused = false;
    try {
      this.lease = await this.options.leases.acquire({ binding: this.binding, attempt: this.attempt });
    } catch (error) {
      if (error instanceof LocalWorkspaceWriterLeaseError && error.awaitAcquisitionQuiescence) {
        this.acquisitionWasUnused = await error.awaitAcquisitionQuiescence(this.attempt);
      }
      throw error;
    }
    this.assertAccepting();
  }

  private async discardOriginal(): Promise<boolean> {
    try {
      await this.acquisition.catch(() => undefined);
      await this.publication?.catch(() => undefined);
      if (this.adopted) return false;
      // Do not poison the writer's single release promise with an unused-release
      // refusal when known admission needs the separate never-dispatched proof.
      if (this.knownAdmission || await this.readExactCandidate()) return false;
      if (this.lease) {
        if (!(await this.lease.releaseUnadmitted(() =>
          this.options.persistence.turnAdmissions.getByTurn(this.admission.turn.id)))) return false;
      } else if (!this.acquisitionWasUnused) {
        // The original never invoked binding only when fenced before its first
        // microtask. A failed/unknown bind is NOT absence or cleanup proof.
        return !this.bindingWasStarted;
      }
      if (!this.binding) return false;
      await this.binding.close();
      return this.binding.rootDirectory.fd === -1;
    } catch {
      // The existing caller reservation retains this exact binding and lease.
      return false;
    }
  }

  private async settleOriginal(input: LocalPhysicalAdmissionSettlement): Promise<boolean> {
    try {
      await this.acquisition.catch(() => undefined);
      await this.publication?.catch(() => undefined);
      if (this.adopted || !this.lease || !this.binding || !(await this.readExactCandidate())) return false;
      try { await input.settleCanonical(this.admission); } catch { /* Reconcile the exact durable result below. */ }
      // The same-writer P11 proof and canonical terminal are checked below; a
      // callback return or a terminal event alone cannot release this lease.
      const proof = await this.readSettlementProof();
      if (!proof || !(await this.lease.release(async (turnId) =>
        turnId === this.admission.turn.id && !this.adopted &&
        isDeepStrictEqual(await this.readSettlementProof(), proof)))) return false;
      await this.binding.close();
      return this.binding.rootDirectory.fd === -1;
    } catch {
      return false;
    }
  }

  private async readSettlementProof(): Promise<HarnessPreOpeningSettlement | null> {
    if (this.adopted || !this.knownAdmission || !(await this.readExactCandidate())) return null;
    const proof = HarnessPreOpeningSettlementResultSchema.parse(
      await this.options.persistence.readHarnessPreOpeningSettlement({ admission: this.admission }),
    );
    if (proof.status !== "verified_pre_opening_settlement" ||
        !isDeepStrictEqual(proof.admission, this.admission) ||
        !isDeepStrictEqual(proof.capture, this.admission.run.harnessSelection)) return null;
    const publication = await readLocalTurnArtifactPublication(this.options.persistence.lifecycleEvents, this.admission);
    if (!publication.terminal || publication.terminal.type === "turn.completed" ||
        !isDeepStrictEqual(publication.terminal, proof.terminal) || this.adopted) return null;
    return proof;
  }

  private assertAccepting(): void {
    if (this.fenced || this.adopted || this.signal.aborted) throw unavailable();
    this.binding?.assertCurrent();
  }
}

function unavailable(): Error {
  return new Error("Physical admission candidate requires recovery");
}

function sameRequest(candidate: TurnAdmission, saved: TurnAdmission): boolean {
  const request = ({ run, turn, userMessage, clientRequestId }: TurnAdmission) => ({
    clientRequestId, workspaceId: run.workspaceId, threadId: run.threadId, userId: run.userId,
    mode: run.mode, providerId: run.providerId, modelId: run.modelId,
    permissionProfileId: run.permissionProfileId, executionCapability: run.executionCapability,
    harnessSelection: run.harnessSelection,
    parentTurnId: turn.parentTurnId, parentItemId: userMessage.parentItemId,
    branchId: userMessage.branchId, type: userMessage.type, content: userMessage.content,
  });
  return isDeepStrictEqual(request(candidate), request(saved));
}
