import { isDeepStrictEqual } from "node:util";
import { TurnAdmissionSchema, type TurnAdmission } from "@repo/platform-protocol";
import type { LocalPersistence } from "@repo/event-store/local";
import type { LocalNativeResourceSettlement } from "@repo/event-store";
import type { LocalTurnAttemptIdentity } from "@legioncode/execution-engine/runtime/desktop/LocalReadOnlyTurnExecutor";
import { verifyLocalNativePredecessorSettlement } from "./local-native-settlement.js";
import type { LocalWorkspaceExecutionBinding, LocalWorkspaceService } from "./local-workspace.js";
import { LocalWorkspaceWriterLeaseError, type LocalWorkspaceWriterLease, type LocalWorkspaceWriterLeaseOwner } from "./local-workspace-writer-lease.js";

type Persistence = Pick<LocalPersistence, "turnAdmissions" | "lifecycleEvents" | "turnArtifacts">;
type AdmissionResult = Awaited<ReturnType<LocalPersistence["turnAdmissions"]["admit"]>>;

export type LocalPhysicalAdmissionPublication =
  | { readonly newlyAdmitted: false; readonly admission: TurnAdmission }
  | { readonly newlyAdmitted: true; readonly admission: TurnAdmission;
      readonly binding: LocalWorkspaceExecutionBinding; readonly lease: LocalWorkspaceWriterLease };

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
  private binding: LocalWorkspaceExecutionBinding | undefined;
  private lease: LocalWorkspaceWriterLease | undefined;
  private acquisitionWasUnused = false;
  private bindingWasStarted = false;
  private fenced = false;
  private adopted = false;

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
      const result = await publishAdmission(this.admission);
      this.assertAccepting();
      const admission = TurnAdmissionSchema.parse(result.admission);
      if (result.newlyAdmitted === false) {
        const byRequest = await this.options.persistence.turnAdmissions.findByRequest(
          this.admission.run.threadId, this.admission.clientRequestId,
        );
        const byTurn = await this.options.persistence.turnAdmissions.getByTurn(admission.turn.id);
        this.assertAccepting();
        if (!sameRequest(this.admission, admission) || !byRequest || !byTurn ||
            !isDeepStrictEqual(TurnAdmissionSchema.parse(byRequest), admission) ||
            !isDeepStrictEqual(TurnAdmissionSchema.parse(byTurn), admission)) throw unavailable();
        return { newlyAdmitted: false, admission };
      }
      if (result.newlyAdmitted !== true || !isDeepStrictEqual(admission, this.admission)) throw unavailable();
      const saved = await this.options.persistence.turnAdmissions.getByTurn(this.admission.turn.id);
      this.assertAccepting();
      if (!saved || !isDeepStrictEqual(TurnAdmissionSchema.parse(saved), this.admission)) throw unavailable();
      await this.lease!.assertCurrent();
      this.assertAccepting();
      this.adopted = true;
      return { newlyAdmitted: true, admission, binding: this.binding!, lease: this.lease! };
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

  private assertAccepting(): void {
    if (this.fenced || this.signal.aborted) throw unavailable();
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
    parentTurnId: turn.parentTurnId, parentItemId: userMessage.parentItemId,
    branchId: userMessage.branchId, type: userMessage.type, content: userMessage.content,
  });
  return isDeepStrictEqual(request(candidate), request(saved));
}
