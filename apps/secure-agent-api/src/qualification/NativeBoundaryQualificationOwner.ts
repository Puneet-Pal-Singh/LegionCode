import { getSandbox } from "@cloudflare/sandbox";
import type { Env } from "../index";
import {
  RESOURCE_POLICY, QualificationCommandSchema, QualificationLeaseSchema, ResourceObservationSchema, ResourceProvisionReceiptSchema,
  ResourceSetupBindingSchema, freezeQualification, isQualificationRecord, qualificationDigest, qualificationToken,
  type QualificationCommand, type QualificationRecord, type ResourceSetupBinding,
} from "./contracts";
import {
  authorizeQualification, constantTimeQualificationEqual,
  type QualificationAuthorization, type QualificationPolicy,
} from "./NativeBoundaryQualificationAuth";

const prefix = "execution:session:";
interface QualificationOriginal {
  readonly id: string;
  readonly promise: Promise<unknown>;
  readonly launch: () => void;
}
/** A disjoint nonproduct row in the EXISTING physical owner/serializer, not a
 * second registry, runtime, product grant or conversation admission path. */
export class NativeBoundaryQualificationOwner {
  private original: QualificationOriginal | undefined;
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async control(auth: QualificationAuthorization, input: QualificationCommand): Promise<unknown> {
    const policy = authorizeQualification(this.env, auth);
    const command = freezeQualification(QualificationCommandSchema.parse(input));
    this.assertOwner(policy);
    if (command.action === "reserve") return this.reserve(policy, command.operationId);
    const admission = await this.state.blockConcurrencyWhile(async (): Promise<
      { kind: "response"; response: unknown } | { kind: "original"; original: QualificationOriginal }
    > => {
      let row = await this.read(policy, command.operationId);
      if (command.action === "status" && row.phase === "retired") return { kind: "response", response: this.publicRecord(row) };
      if (!constantTimeQualificationEqual(row.token, auth.bearer) || row.phase === "retired") throw unavailable();
      if (!this.original && ["starting", "observed", "provisioning", "retiring"].includes(row.phase)) {
        // Read current phase and current original under the SAME serializer.
        // A stale status read cannot overwrite a positively provisioned row.
        row = { ...row, phase: "unknown", failureCode: "QUALIFICATION_ORIGINAL_UNKNOWN", originalTransportSettled: undefined };
        await this.state.storage.put(this.key(command.operationId), row);
      }
      if (command.action === "status") return { kind: "response", response: this.publicRecord(row) };
      if (this.original) throw unavailable();
      const retiring = command.action === "retire";
      if (retiring ? row.phase !== "provisioned" || row.originalTransportSettled !== true || !row.receipt || !row.observation
        : row.phase !== "reserved" || row.lease.expiresAt <= Date.now()) throw unavailable();
      const admitted: QualificationRecord = { ...row, phase: retiring ? "retiring" : "starting",
        originalId: qualificationToken(), rawDispatched: undefined,
        originalTransportSettled: retiring ? row.originalTransportSettled : undefined };
      // No original is registered until this admission write succeeds. A
      // pre-effect duplicate/CAS loser therefore cannot poison a later retire.
      await this.state.storage.put(this.key(command.operationId), admitted);
      const original = this.registerOriginal(() => retiring
        ? this.retire(auth, policy, admitted) : this.provision(auth, policy, admitted), admitted.originalId!);
      return { kind: "original", original };
    });
    if (admission.kind === "response") return admission.response;
    // The descriptor was registered inside the admission serializer; its
    // effects start only after that serializer has released for raw callbacks.
    admission.original.launch();
    return admission.original.promise;
  }

  async admitRaw(auth: QualificationAuthorization, input: ResourceSetupBinding, sandboxObjectId: string, action: "observe" | "provision" | "retire"): Promise<boolean> {
    try {
      const policy = authorizeQualification(this.env, auth);
      this.assertOwner(policy);
      const binding = freezeQualification(ResourceSetupBindingSchema.parse(input));
      return await this.state.blockConcurrencyWhile(async () => {
        const original = this.original;
        if (!original) return false;
        const row = await this.read(policy, binding.operationId);
        const expectedPhase = action === "observe" ? "starting" : action === "provision" ? "provisioning" : "retiring";
        if (row.phase !== expectedPhase || row.originalId !== original.id || this.original !== original || row.rawDispatched !== undefined ||
          (action !== "retire" && row.lease.expiresAt <= Date.now()) || row.lease.sandboxObjectId !== sandboxObjectId ||
          !constantTimeQualificationEqual(row.token, auth.bearer) || JSON.stringify(this.binding(row)) !== JSON.stringify(binding)) return false;
        // The exact physical owner consumes this stage's one-shot creator gate
        // durably before the Sandbox may start/observe/provision/destroy.
        await this.state.storage.put(this.key(binding.operationId), { ...row, rawDispatched: action });
        return true;
      });
    } catch { return false; }
  }

  async continueRaw(auth: QualificationAuthorization, input: ResourceSetupBinding, sandboxObjectId: string,
    action: "observe" | "provision"): Promise<boolean> {
    try {
      const policy = authorizeQualification(this.env, auth);
      this.assertOwner(policy);
      const binding = freezeQualification(ResourceSetupBindingSchema.parse(input));
      return await this.state.blockConcurrencyWhile(async () => {
        const original = this.original;
        if (!original) return false;
        const row = await this.read(policy, binding.operationId);
        return row.originalId === original.id && this.original === original && row.rawDispatched === action &&
          row.phase === (action === "observe" ? "starting" : "provisioning") && row.lease.expiresAt > Date.now() &&
          row.lease.sandboxObjectId === sandboxObjectId && constantTimeQualificationEqual(row.token, auth.bearer) &&
          JSON.stringify(this.binding(row)) === JSON.stringify(binding);
      });
    } catch { return false; }
  }

  private registerOriginal(effect: () => Promise<unknown>, id: string): QualificationOriginal {
    let launch!: () => void;
    let launched = false;
    const promise = new Promise<unknown>((resolve, reject) => {
      launch = () => {
        if (launched) return;
        launched = true;
        void Promise.resolve().then(effect).then(resolve, reject);
      };
    });
    const original = Object.freeze({ id, promise, launch });
    this.original = original;
    void promise.then(() => {
      if (this.original === original) this.original = undefined;
    }, () => { /* An actual ambiguous original stays retained, including rejection. */ });
    return original;
  }
  private assertOwner(policy: QualificationPolicy): void {
    const expected = this.env.AGENT_RUNTIME.idFromName(`native-boundary-qualification:${policy.subject.environmentId}`).toString();
    if (this.state.id.toString() !== expected) throw unavailable();
  }
  private key(operationId: string): string { return `${prefix}operator:${operationId}`; }
  private async reserve(policy: QualificationPolicy, operationId: string): Promise<unknown> {
    return this.state.blockConcurrencyWhile(async () => {
      const entries = await this.state.storage.list<unknown>({ prefix });
      const existing = entries.get(this.key(operationId));
      if (existing !== undefined) {
        const row = await this.read(policy, operationId);
        if (row.phase === "retired") throw unavailable();
        return { ...this.publicRecord(row), bearer: row.token };
      }
      // Freshness also requires Root's complete provider creation inventory.
      // An empty local DO alone is never advertised as proof of that inventory.
      if (entries.size !== 0 || this.original) throw unavailable();
      const sandboxId = `sb-${crypto.randomUUID().replaceAll("-", "")}`;
      const lease = freezeQualification({
        sessionId: `operator_${crypto.randomUUID()}`, leaseId: `operator_lease_${crypto.randomUUID()}`,
        sandboxId, sandboxObjectId: this.env.Sandbox.idFromName(sandboxId).toString(),
        ownerId: this.state.id.toString(), physicalAttemptKey: `native_boundary_qualification:${operationId}`, generation: 0 as const,
        expiresAt: Date.now() + 15 * 60_000,
      });
      const identity = { subject: { ...policy.subject, operationId }, pins: policy.pins, lease };
      const row: QualificationRecord = { kind: "native_boundary_qualification", version: 1, ...identity,
        authorityDigest: await qualificationDigest(identity), token: qualificationToken(), phase: "reserved" };
      // This server-issued exclusive disposable grant precedes getSandbox,
      // container startup, observation, cgroup mkdir and every other effect.
      await this.state.storage.put(this.key(operationId), row);
      return { ...this.publicRecord(row), bearer: row.token };
    });
  }
  private async read(policy: QualificationPolicy, operationId: string): Promise<QualificationRecord> {
    const entries = await this.state.storage.list<unknown>({ prefix });
    const row = entries.get(this.key(operationId));
    if (entries.size !== 1 || !isQualificationRecord(row) || row.version !== 1 || row.subject.operationId !== operationId ||
      JSON.stringify(row.subject) !== JSON.stringify({ ...policy.subject, operationId }) ||
      JSON.stringify(row.pins) !== JSON.stringify(policy.pins) || row.lease.ownerId !== this.state.id.toString() ||
      this.env.Sandbox.idFromName(row.lease.sandboxId).toString() !== row.lease.sandboxObjectId ||
      row.authorityDigest !== await qualificationDigest({ subject: row.subject, pins: row.pins, lease: row.lease })) throw unavailable();
    QualificationLeaseSchema.parse(row.lease);
    return row;
  }
  private binding(row: QualificationRecord): ResourceSetupBinding {
    return freezeQualification(ResourceSetupBindingSchema.parse({ purpose: "native_boundary_qualification",
      operatorAccountId: row.subject.operatorAccountId, controlPrincipal: row.subject.controlPrincipal,
      environmentId: row.subject.environmentId, operationId: row.subject.operationId,
      sessionId: row.lease.sessionId, leaseId: row.lease.leaseId, sandboxId: row.lease.sandboxId,
      generation: row.lease.generation, physicalOwnerId: row.lease.ownerId, physicalAttemptKey: row.lease.physicalAttemptKey,
      authorityDigest: row.authorityDigest, parentAuthorityDigest: row.subject.authorityReceiptSha256,
      expiresAt: row.lease.expiresAt,
      physicalOwnerAuditHash: row.subject.authorityReceiptSha256,
    }));
  }
  private async transition(policy: QualificationPolicy, row: QualificationRecord, phase: QualificationRecord["phase"], patch: Partial<QualificationRecord> = {}): Promise<QualificationRecord> {
    return this.state.blockConcurrencyWhile(async () => {
      const current = await this.read(policy, row.subject.operationId);
      if (current.phase !== row.phase || current.authorityDigest !== row.authorityDigest ||
        current.originalId !== row.originalId || this.original?.id !== row.originalId) throw unavailable();
      const next = { ...current, ...patch, phase, rawDispatched: undefined };
      await this.state.storage.put(this.key(row.subject.operationId), next);
      return next;
    });
  }
  private async provision(auth: QualificationAuthorization, policy: QualificationPolicy, initial: QualificationRecord): Promise<unknown> {
    let row = initial;
    try {
      if (row.phase !== "starting" || this.original?.id !== row.originalId) throw unavailable();
      const binding = this.binding(row);
      const sandbox = getSandbox(this.env.Sandbox, row.lease.sandboxId);
      const observationOriginal = Promise.resolve().then(() => sandbox.qualificationObserveResources(auth, {
        version: 1, binding, policy: RESOURCE_POLICY,
      }));
      const observation = ResourceObservationSchema.parse(await observationOriginal);
      if (JSON.stringify(observation.binding) !== JSON.stringify(binding) || observation.helperSha256 !== policy.pins.helperSha256) throw unavailable();
      row = await this.transition(policy, row, "observed", { observation, originalTransportSettled: true });
      row = await this.transition(policy, row, "provisioning", { originalTransportSettled: undefined });
      const provisionOriginal = Promise.resolve().then(() => sandbox.qualificationProvisionResources(auth, {
        version: 1, binding, policy: RESOURCE_POLICY, expectedBootId: observation.sandboxBootId, expectedParent: observation.parent.identity,
      }));
      const receipt = ResourceProvisionReceiptSchema.parse(await provisionOriginal);
      if (JSON.stringify(receipt.binding) !== JSON.stringify(binding) || receipt.sandboxBootId !== observation.sandboxBootId ||
        receipt.parent.identity.device !== observation.parent.identity.device || receipt.parent.identity.inode !== observation.parent.identity.inode) throw unavailable();
      row = await this.transition(policy, row, "provisioned", { receipt, originalTransportSettled: true });
      return this.publicRecord(row);
    } catch {
      await this.unknown(policy, row);
      throw unavailable();
    }
  }
  private async retire(auth: QualificationAuthorization, policy: QualificationPolicy, initial: QualificationRecord): Promise<unknown> {
    // No workload creator exists in this fixed setup scenario. Missing original
    // startup/helper channels, restart ambiguity or unobserved receipts retain
    // authority; an operator retry never guesses that unknown work disappeared.
    const row = initial;
    try {
      if (row.phase !== "retiring" || this.original?.id !== row.originalId || row.originalTransportSettled !== true || !row.receipt || !row.observation) throw unavailable();
      const sandbox = getSandbox(this.env.Sandbox, row.lease.sandboxId);
      const original = Promise.resolve().then(() => sandbox.qualificationDestroy(auth, this.binding(row)));
      await original;
      const retired = await this.transition(policy, row, "retired", { token: "", originalTransportSettled: true });
      return this.publicRecord(retired);
    } catch {
      await this.unknown(policy, row);
      throw unavailable();
    }
  }
  private async unknown(policy: QualificationPolicy, row: QualificationRecord): Promise<void> {
    await this.state.blockConcurrencyWhile(async () => {
      const current = await this.read(policy, row.subject.operationId);
      if (current.authorityDigest !== row.authorityDigest || current.phase !== row.phase ||
        current.originalId !== row.originalId || this.original?.id !== row.originalId || current.phase === "retired") return;
      await this.state.storage.put(this.key(row.subject.operationId), { ...current, phase: "unknown",
        failureCode: "QUALIFICATION_ORIGINAL_UNKNOWN", originalTransportSettled: undefined });
    });
    // Keep this.original, including its rejection. Neither a status call nor a
    // code/DO restart can manufacture original streams or recreate the grant.
  }
  private publicRecord(row: QualificationRecord) {
    return { purpose: row.kind, subject: row.subject, pins: row.pins, lease: row.lease,
      authorityDigest: row.authorityDigest, phase: row.phase, originalTransportSettled: row.originalTransportSettled === true,
      observation: row.observation, receipt: row.receipt, failureCode: row.failureCode,
      active: row.phase !== "retired", runtimeQualified: false as const };
  }
}
function unavailable(): Error { return new Error("NATIVE_QUALIFICATION_ORIGINAL_OR_AUTHORITY_UNAVAILABLE"); }
