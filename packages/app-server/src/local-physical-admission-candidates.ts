import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { HarnessAdmissionSelectionSchema, HarnessSelectionSchema, TurnAdmissionSchema,
  type HarnessSelection, type TurnAdmission } from "@repo/platform-protocol";
import type { LocalPersistence } from "@repo/event-store/local";
import {
  HarnessPreOpeningSettlementResultSchema,
  type HarnessPreOpeningSettlement,
  type LocalNativeResourceSettlement,
  StoredHarnessSelectionSchema, type StoredHarnessSelection,
  StoredHarnessPreparationSchema, type HarnessPreparationInput,
} from "@repo/event-store";
import type { LocalTurnAttemptIdentity } from "@legioncode/execution-engine/runtime/desktop/LocalReadOnlyTurnExecutor";
import { verifyLocalNativePredecessorSettlement } from "./local-native-settlement.js";
import { readLocalTurnArtifactPublication } from "./local-turn-artifact-publication.js";
import type { LocalWorkspaceExecutionBinding, LocalWorkspaceService } from "./local-workspace.js";
import { LocalWorkspaceWriterLeaseError, type LocalWorkspaceWriterLease, type LocalWorkspaceWriterLeaseOwner } from "./local-workspace-writer-lease.js";

type Persistence = Pick<LocalPersistence, "turnAdmissions" | "lifecycleEvents" | "turnArtifacts" |
  "harnessBindings" | "admitHarnessPreparation" | "cancelHarnessPreparation" |
  "readHarnessPreparation" | "readHarnessPreOpeningSettlement">;
type AdmissionResult = Awaited<ReturnType<LocalPersistence["admitHarnessPreparation"]>>;
type PublishAdmission = (candidate: TurnAdmission, preparation: HarnessPreparationInput) => Promise<AdmissionResult>;

export type LocalPhysicalAdmissionPublication =
  | { readonly newlyAdmitted: false; readonly admission: TurnAdmission }
  | { readonly newlyAdmitted: true; readonly admission: TurnAdmission;
      readonly disposition: "execution";
      readonly preparation: HarnessPreparationInput;
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
  publish(publishAdmission: PublishAdmission): Promise<LocalPhysicalAdmissionPublication>;
  /** Permanently fences publication/adoption, drains both original promises,
   * then asks the same writer entry to verify canonical absence before release. */
  discardUnadmitted(): Promise<boolean>;
  settleBeforeDispatch(input: LocalPhysicalAdmissionSettlement): Promise<boolean>;
}

export interface LocalPhysicalAdmissionCandidates {
  /** Synchronous reservation; deferred acquisition cannot start before return. */
  acquire(input: LocalPhysicalAdmissionCandidateInput): LocalPhysicalAdmissionCandidate;
}

export interface LocalPhysicalAdmissionCandidateInput {
  readonly candidate: TurnAdmission;
  /** Actual private resolved policy, runtime, grant and account-generation pins. */
  readonly selection: HarnessSelection;
  readonly signal: AbortSignal;
}

/** Trusted Desktop supplies the SAME writer owner used by Native and commits.
 * No independent fence namespace, admission store or attempt registry is created. */
export function createLocalPhysicalAdmissionCandidates(options: {
  readonly persistence: Persistence;
  readonly workspaces: LocalWorkspaceService;
  readonly leases: LocalWorkspaceWriterLeaseOwner;
}): LocalPhysicalAdmissionCandidates {
  return Object.freeze({
    acquire: (input: LocalPhysicalAdmissionCandidateInput) =>
      new PhysicalAdmissionCandidate(options, input),
  });
}

class PhysicalAdmissionCandidate implements LocalPhysicalAdmissionCandidate {
  private readonly admission: TurnAdmission;
  private readonly selection: HarnessSelection;
  private readonly storedSelection: StoredHarnessSelection;
  private readonly preparation: HarnessPreparationInput;
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

  constructor(private readonly options: Parameters<typeof createLocalPhysicalAdmissionCandidates>[0], input: LocalPhysicalAdmissionCandidateInput) {
    this.admission = TurnAdmissionSchema.parse(input.candidate);
    this.selection = HarnessSelectionSchema.parse(input.selection);
    this.storedSelection = freezeCandidateSelection(this.admission, this.selection);
    this.preparation = Object.freeze({ selection: this.storedSelection, preparationId: randomUUID() });
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

  publish(publishAdmission: PublishAdmission): Promise<LocalPhysicalAdmissionPublication> {
    if (this.fenced || this.publication || this.adopted) return Promise.reject(unavailable());
    // Store this entire operation, including validation, before invoking the
    // publisher. Discard must drain this original, never a replacement lookup.
    this.publication = Promise.resolve().then<LocalPhysicalAdmissionPublication>(async () => {
      await this.ready();
      this.assertAccepting();
      let result: AdmissionResult;
      try {
        result = await publishAdmission(this.admission, this.preparation);
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
        const binding = await this.options.persistence.harnessBindings.read({
          userId: admission.run.userId, turnId: admission.turn.id, runAttemptId: admission.runAttemptId,
        });
        if (!binding) throw unavailable();
        const winnerSelection = HarnessSelectionSchema.parse(JSON.parse(binding.selection.selectionJson));
        const storedWinner = freezeCandidateSelection(admission, winnerSelection);
        if (!isDeepStrictEqual(binding.selection, storedWinner)) throw unavailable();
        const preparation = await this.options.persistence.readHarnessPreparation({ selection: storedWinner });
        if (!preparation || StoredHarnessPreparationSchema.parse(preparation).preparationId !==
            StoredHarnessPreparationSchema.parse(result.preparation).preparationId) throw unavailable();
        return { newlyAdmitted: false, admission };
      }
      if (result.newlyAdmitted !== true || !isDeepStrictEqual(admission, this.admission)) throw unavailable();
      if (!(await this.readExactCandidate())) throw unavailable();
      const preparation = await this.options.persistence.readHarnessPreparation({ selection: this.storedSelection });
      if (!preparation || preparation.preparationId !== this.preparation.preparationId ||
          StoredHarnessPreparationSchema.parse(preparation).preparationId !==
            StoredHarnessPreparationSchema.parse(result.preparation).preparationId) throw unavailable();
      if (preparation.phase !== "reserved") return this.requireSettlement();
      if (this.fenced || this.signal.aborted) return this.requireSettlement();
      try {
        await this.lease!.assertCurrent();
        this.assertAccepting();
      } catch {
        return this.requireSettlement();
      }
      this.adopted = true;
      return { newlyAdmitted: true, disposition: "execution", admission, preparation: this.preparation,
        binding: this.binding!, lease: this.lease! };
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
      if (!this.lease || !this.binding || !(await this.readExactCandidate())) return false;
      let cancellation: Promise<boolean> | undefined;
      let proof: HarnessPreOpeningSettlement | null = null;
      // The same physical entry seals NEW work before invoking this callback.
      // A begun CAS loses this path and leaves the normal runtime release usable.
      if (!(await this.lease.releaseBeforeExposure(async (turnId) => {
        if (turnId !== this.admission.turn.id) return false;
        cancellation ??= Promise.resolve().then(async () => {
          if (await this.options.persistence.cancelHarnessPreparation(this.preparation) !== "cancelled_before_preparation") return false;
          try { await input.settleCanonical(this.admission); } catch { /* Reconcile its durable result. */ }
          return true;
        });
        if (!(await cancellation)) return false;
        const current = await this.readSettlementProof();
        if (!current) return false;
        if (!proof) proof = current;
        return isDeepStrictEqual(current, proof);
      }))) return false;
      await this.binding.close();
      return this.binding.rootDirectory.fd === -1;
    } catch {
      return false;
    }
  }

  private async readSettlementProof(): Promise<HarnessPreOpeningSettlement | null> {
    if (!this.knownAdmission || !(await this.readExactCandidate())) return null;
    const proof = HarnessPreOpeningSettlementResultSchema.parse(
      await this.options.persistence.readHarnessPreOpeningSettlement({ admission: this.admission }),
    );
    if (proof.status !== "verified_pre_opening_settlement" ||
        !isDeepStrictEqual(proof.admission, this.admission) ||
        !isDeepStrictEqual(proof.capture, this.admission.run.harnessSelection) ||
        proof.state.kind !== "cancelled_before_preparation" ||
        !isDeepStrictEqual(proof.state.selection, this.storedSelection) ||
        proof.state.preparation.preparationId !== this.preparation.preparationId ||
        proof.state.preparation.phase !== "cancelled_before_preparation") return null;
    const publication = await readLocalTurnArtifactPublication(this.options.persistence.lifecycleEvents, this.admission);
    if (!publication.terminal || publication.terminal.type === "turn.completed" ||
        !isDeepStrictEqual(publication.terminal, proof.terminal)) return null;
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
  const request = ({ run, userMessage, clientRequestId }: TurnAdmission) => {
    if (userMessage.type !== "user_message") throw unavailable();
    return {
      clientRequestId, workspaceId: run.workspaceId, threadId: run.threadId, userId: run.userId,
      text: userMessage.content.text, imageFingerprint: userMessage.content.imageFingerprint,
      harnessSelection: HarnessAdmissionSelectionSchema.parse(run.harnessSelection),
      // Explicit request configuration travels in content. Current resolved
      // defaults, policy, provider, lineage and private pins are not retry intent.
      configuration: userMessage.content.configuration,
    };
  };
  return isDeepStrictEqual(request(candidate), request(saved));
}

/** Entire private binding is parsed/frozen before the deferred first await. */
function freezeCandidateSelection(admission: TurnAdmission, selection: HarnessSelection): StoredHarnessSelection {
  if (admission.run.executionCapability !== "repository" || admission.userMessage.type !== "user_message") throw unavailable();
  const capture = HarnessAdmissionSelectionSchema.parse(admission.run.harnessSelection);
  const contentCapture = HarnessAdmissionSelectionSchema.parse(admission.userMessage.content.harnessSelection);
  const chosen = capture.selection;
  if (!chosen || !isDeepStrictEqual(capture, contentCapture) ||
      selection.userId !== admission.run.userId || selection.workspaceId !== admission.run.workspaceId ||
      selection.threadId !== admission.run.threadId || selection.runId !== admission.run.id ||
      selection.turnId !== admission.turn.id || selection.runAttemptId !== admission.runAttemptId ||
      selection.environmentId !== capture.environmentId || selection.selectionRevision !== capture.selectionRevision ||
      selection.harness !== chosen.harness || selection.instanceId !== chosen.instanceId ||
      selection.connectionId !== chosen.connectionId || selection.modelId !== chosen.modelId ||
      selection.modelId !== admission.run.modelId || selection.policyId !== admission.run.permissionProfileId) throw unavailable();
  return Object.freeze(StoredHarnessSelectionSchema.parse({
    userId: selection.userId, workspaceId: selection.workspaceId, sessionId: selection.threadId,
    threadId: selection.threadId, runId: selection.runId, turnId: selection.turnId,
    runAttemptId: selection.runAttemptId, selectionJson: JSON.stringify(selection),
  }));
}
