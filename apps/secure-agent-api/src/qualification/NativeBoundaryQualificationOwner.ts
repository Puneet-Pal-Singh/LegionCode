import { getSandbox } from "@cloudflare/sandbox";
import type { Env } from "../index";
import {
  RESOURCE_POLICY, QualificationCommandSchema, QualificationLeaseSchema, ResourceObservationSchema, ResourceProvisionReceiptSchema,
  ResourceSetupBindingSchema, QualificationFixtureSchema, QualificationNamespaceReceiptSchema, QualificationMarkersSchema, freezeQualification, isQualificationRecord, qualificationDigest, qualificationToken,
  type QualificationCommand, type QualificationRecord, type ResourceSetupBinding, type QualificationRawAction, type QualificationNamespaceReceipt,
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
  readonly controls: Set<Promise<unknown>>;
  readonly resources: { namespace?: Promise<QualificationNamespaceReceipt> };
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
    if (command.action === "stop") return this.stopNamespace(auth, policy, command.operationId);
    const admission = await this.state.blockConcurrencyWhile(async (): Promise<
      { kind: "response"; response: unknown } | { kind: "original"; original: QualificationOriginal }
    > => {
      let row = await this.read(policy, command.operationId);
      if (command.action === "status" && row.phase === "retired") return { kind: "response", response: this.publicRecord(row) };
      if (!constantTimeQualificationEqual(row.token, auth.bearer) || row.phase === "retired") throw unavailable();
      if (!this.original && ["starting", "observed", "provisioning", "retiring", "qualifying_fixture", "qualifying_namespace", "namespace_running", "qualifying_verify"].includes(row.phase)) {
        // Read current phase and current original under the SAME serializer.
        // A stale status read cannot overwrite a positively provisioned row.
        row = { ...row, phase: "unknown", failureCode: "QUALIFICATION_ORIGINAL_UNKNOWN", originalTransportSettled: undefined };
        await this.state.storage.put(this.key(command.operationId), row);
      }
      if (command.action === "status") return { kind: "response", response: this.publicRecord(row) };
      if (this.original) throw unavailable();
      const retiring = command.action === "retire";
      const qualifying = command.action === "qualify";
      if (retiring ? !["provisioned", "namespace_observed", "namespace_closed"].includes(row.phase) || row.originalTransportSettled !== true || !row.receipt || !row.observation
        : qualifying ? row.phase !== "provisioned" || !row.receipt || row.lease.expiresAt <= Date.now()
        : row.phase !== "reserved" || row.lease.expiresAt <= Date.now()) throw unavailable();
      if (retiring && row.namespace && (row.namespace.controlAdmissionClosed !== true || row.namespace.originalTransportSettled !== true ||
        !row.namespace.receipt?.gateClosed || !["closed", "not_started"].includes(row.namespace.receipt.state))) throw unavailable();
      const admitted: QualificationRecord = { ...row, phase: retiring ? "retiring" : qualifying ? "qualifying_fixture" : "starting",
        ...(qualifying ? { namespace: { nonce: qualificationToken(), controlToken: qualificationToken() } } : {}),
        originalId: qualificationToken(), rawDispatched: undefined,
        originalTransportSettled: retiring ? row.originalTransportSettled : undefined };
      // No original is registered until this admission write succeeds. A
      // pre-effect duplicate/CAS loser therefore cannot poison a later retire.
      await this.state.storage.put(this.key(command.operationId), admitted);
      const original = this.registerOriginal(() => retiring
        ? this.retire(auth, policy, admitted) : qualifying ? this.qualifyNamespace(auth, policy, admitted) : this.provision(auth, policy, admitted), admitted.originalId!);
      return { kind: "original", original };
    });
    if (admission.kind === "response") return admission.response;
    // The descriptor was registered inside the admission serializer; its
    // effects start only after that serializer has released for raw callbacks.
    admission.original.launch();
    return admission.original.promise;
  }

  async admitRaw(auth: QualificationAuthorization, input: ResourceSetupBinding, sandboxObjectId: string, action: QualificationRawAction): Promise<boolean> {
    try {
      const policy = authorizeQualification(this.env, auth);
      this.assertOwner(policy);
      const binding = freezeQualification(ResourceSetupBindingSchema.parse(input));
      return await this.state.blockConcurrencyWhile(async () => {
        const original = this.original;
        if (!original) return false;
        const row = await this.read(policy, binding.operationId);
        const expectedPhase = rawPhase(action);
        if (row.phase !== expectedPhase || row.originalId !== original.id || this.original !== original || row.rawDispatched !== undefined ||
          (!["retire", "verify"].includes(action) && row.lease.expiresAt <= Date.now()) || row.lease.sandboxObjectId !== sandboxObjectId ||
          !constantTimeQualificationEqual(row.token, auth.bearer) || JSON.stringify(this.binding(row)) !== JSON.stringify(binding)) return false;
        // The exact physical owner consumes this stage's one-shot creator gate
        // durably before the Sandbox may start/observe/provision/destroy.
        await this.state.storage.put(this.key(binding.operationId), { ...row, rawDispatched: action });
        return true;
      });
    } catch { return false; }
  }

  async continueRaw(auth: QualificationAuthorization, input: ResourceSetupBinding, sandboxObjectId: string,
    action: Exclude<QualificationRawAction, "retire">): Promise<boolean> {
    try {
      const policy = authorizeQualification(this.env, auth);
      this.assertOwner(policy);
      const binding = freezeQualification(ResourceSetupBindingSchema.parse(input));
      return await this.state.blockConcurrencyWhile(async () => {
        const original = this.original;
        if (!original) return false;
        const row = await this.read(policy, binding.operationId);
        return row.originalId === original.id && this.original === original && row.rawDispatched === action &&
          row.phase === rawPhase(action) && (action === "verify" || row.lease.expiresAt > Date.now()) &&
          row.lease.sandboxObjectId === sandboxObjectId && constantTimeQualificationEqual(row.token, auth.bearer) &&
          JSON.stringify(this.binding(row)) === JSON.stringify(binding);
      });
    } catch { return false; }
  }

  async authorizeNamespaceControl(auth: QualificationAuthorization, input: ResourceSetupBinding, nonce: string,
    token: string, identity: unknown, action: "status" | "start" | "stop" | "ack", sandboxObjectId: string): Promise<boolean> {
    try {
      const policy = authorizeQualification(this.env, auth);
      this.assertOwner(policy);
      const binding = ResourceSetupBindingSchema.parse(input);
      return await this.state.blockConcurrencyWhile(async () => {
        const row = await this.read(policy, binding.operationId);
        const current = this.original;
        const scope = row.namespace;
        if (!current || current.id !== row.originalId || !scope || scope.nonce !== nonce || !constantTimeQualificationEqual(scope.controlToken, token) ||
          !constantTimeQualificationEqual(row.token, auth.bearer) || row.lease.sandboxObjectId !== sandboxObjectId ||
          JSON.stringify(this.binding(row)) !== JSON.stringify(binding)) return false;
        if (action === "start" && (scope.controlAdmissionClosed === true || scope.stopRequested === true || row.lease.expiresAt <= Date.now() || !scope.identity || JSON.stringify(scope.identity) !== JSON.stringify(identity))) return false;
        if (action === "stop" && scope.stopRequested !== true) return false;
        if (action === "ack" && (!scope.receipt || !scope.receiptSha256 || !scope.identity || JSON.stringify(scope.identity) !== JSON.stringify(identity))) return false;
        return ["qualifying_namespace", "namespace_running", "unknown"].includes(row.phase);
      });
    } catch { return false; }
  }

  private async patchNamespace(policy: QualificationPolicy, expected: QualificationRecord, patch: Partial<Omit<NonNullable<QualificationRecord["namespace"]>, "controlAdmissionClosed">>): Promise<QualificationRecord> {
    return this.state.blockConcurrencyWhile(async () => {
      const row = await this.read(policy, expected.subject.operationId);
      if (!row.namespace || row.originalId !== expected.originalId || this.original?.id !== expected.originalId || row.authorityDigest !== expected.authorityDigest) throw unavailable();
      const next = { ...row, namespace: { ...row.namespace, ...patch } };
      await this.state.storage.put(this.key(row.subject.operationId), next);
      return next;
    });
  }

  private async stopNamespace(auth: QualificationAuthorization, policy: QualificationPolicy, operationId: string): Promise<unknown> {
    const admitted = await this.state.blockConcurrencyWhile(async () => {
      const row = await this.read(policy, operationId);
      const original = this.original;
      if (!row.namespace || !constantTimeQualificationEqual(row.token, auth.bearer)) throw unavailable();
      // The final barrier closes admission in the SAME serializer before it
      // snapshots original controls. A later Stop is a read-only observation,
      // including after positive closure has released the original descriptor.
      if (row.namespace.controlAdmissionClosed === true) return { row };
      if (!original || row.originalId !== original.id ||
        !["qualifying_namespace", "namespace_running", "unknown"].includes(row.phase)) throw unavailable();
      if (row.namespace.stopRequested) return { row };
      const next = { ...row, namespace: { ...row.namespace, stopRequested: true as const } };
      await this.state.storage.put(this.key(operationId), next);
      let launch!: () => void;
      const promise = new Promise<QualificationRecord>((resolve, reject) => { launch = () => {
        const sandbox = getSandbox(this.env.Sandbox, row.lease.sandboxId);
        void sandbox.qualificationNamespaceControl(auth, this.binding(next), row.namespace!.nonce,
          row.namespace!.controlToken, row.namespace!.identity, "stop")
          .then(() => this.patchNamespace(policy, next, { stopControlSettled: true })).then(resolve, reject);
      }; });
      original.controls.add(promise);
      void promise.catch(() => undefined);
      return { row: next, promise, launch };
    });
    if (admitted.launch && admitted.promise) {
      admitted.launch();
      try {
        return this.publicRecord(await admitted.promise);
      } catch { await this.unknown(policy, admitted.row); throw unavailable(); }
    }
    return this.publicRecord(admitted.row);
  }

  private async qualifyNamespace(auth: QualificationAuthorization, policy: QualificationPolicy, initial: QualificationRecord): Promise<unknown> {
    let row = initial;
    const current = this.original;
    try {
      if (!current || row.originalId !== current.id || !row.namespace || row.phase !== "qualifying_fixture" || !row.observation) throw unavailable();
      const sandbox = getSandbox(this.env.Sandbox, row.lease.sandboxId);
      const binding = this.binding(row), nonce = row.namespace.nonce;
      const fixture = QualificationFixtureSchema.parse(await sandbox.qualificationFixture(auth, { binding, nonce }, "prepare"));
      if (fixture.helperSha256 !== policy.pins.helperSha256 || fixture.sandboxBootId !== row.observation.sandboxBootId || fixture.root !== `/home/sandbox/checkouts/operator-qualification-${nonce}`) throw unavailable();
      row = await this.transition(policy, row, "qualifying_namespace", { namespace: { fixture } });
      const intent = row.namespace!;
      const original = Promise.resolve().then(() => sandbox.qualificationStartNamespace(auth, { binding, nonce, fixture, controlToken: intent.controlToken }));
      current.resources.namespace = original; // Retained even if the workflow observer fails before ACK.
      let originalOutcome: PromiseSettledResult<unknown> | undefined;
      void original.then(value => { originalOutcome = { status: "fulfilled", value }; }, reason => { originalOutcome = { status: "rejected", reason }; });
      let closed: QualificationNamespaceReceipt | undefined;
      const deadline = Date.now() + 70_000;
      let startDispatched = false;
      while (Date.now() < deadline) {
        if (originalOutcome) throw unavailable();
        let receipt: QualificationNamespaceReceipt;
        try { receipt = QualificationNamespaceReceiptSchema.parse(await sandbox.qualificationNamespaceControl(auth, binding, nonce, intent.controlToken, row.namespace?.identity, "status")); }
        catch { await qualificationPause(); continue; }
        if (JSON.stringify(receipt.binding) !== JSON.stringify({ qualification: binding, nonce }) || receipt.state === "unknown") throw unavailable();
        if (receipt.identity && !row.namespace?.identity) {
          if (receipt.identity.bootId !== fixture.sandboxBootId || receipt.identity.root.device !== fixture.identity.device || receipt.identity.root.inode !== fixture.identity.inode ||
            receipt.identity.metadataIdentity !== fixture.fingerprint || receipt.identity.limits.memoryBytes !== 512 * 1024 * 1024 || receipt.identity.limits.pids !== 128 ||
            receipt.identity.limits.cpuQuotaMicros !== 100_000 || receipt.identity.limits.cpuPeriodMicros !== 100_000 ||
            receipt.identity.cgroup.device !== row.receipt?.commands.identity.device || receipt.identity.cgroup.inode === row.receipt?.commands.identity.inode) throw unavailable();
          row = await this.patchNamespace(policy, row, { identity: receipt.identity });
        }
        if (receipt.identity && JSON.stringify(receipt.identity) !== JSON.stringify(row.namespace?.identity)) throw unavailable();
        if (receipt.state === "prepared" && !startDispatched && !row.namespace?.stopRequested) {
          startDispatched = true;
          // Persist the single gate dispatch before it can create workload code.
          row = await this.transition(policy, row, "namespace_running");
          if (!row.namespace?.stopRequested) {
            await sandbox.qualificationNamespaceControl(auth, binding, nonce, intent.controlToken, row.namespace?.identity, "start");
          }
        }
        if (receipt.admission && receipt.stdout && !row.namespace?.payloadReady) {
          const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(atob(receipt.stdout), character => character.charCodeAt(0)));
          if (text.includes('"payload":"qualification_children_started"')) {
            row = await this.patchNamespace(policy, row, { payloadReady: true });
            await qualificationPause();
            // First finite recipe invokes the SAME real Stop route while all
            // three known detached subprocess classes are actively writing.
            await this.stopNamespace(auth, policy, row.subject.operationId);
            row = await this.read(policy, row.subject.operationId);
          }
        }
        if (receipt.state === "closed" || receipt.state === "not_started") { closed = receipt; break; }
        await qualificationPause();
        row = await this.read(policy, row.subject.operationId);
      }
      if (!closed || !["closed", "not_started"].includes(closed.state) || !closed.gateClosed || !closed.identity) throw unavailable();
      const controls = await this.state.blockConcurrencyWhile(async () => {
        const latest = await this.read(policy, row.subject.operationId);
        if (this.original !== current || latest.originalId !== current.id || latest.authorityDigest !== row.authorityDigest || !latest.namespace ||
          JSON.stringify(latest.namespace.identity) !== JSON.stringify(closed.identity)) throw unavailable();
        // Persist the admission seal BEFORE capturing loans. stopNamespace
        // uses this serializer too, so every admitted original is in this set
        // and no later request can append a control behind the final barrier.
        await this.state.storage.put(this.key(row.subject.operationId), {
          ...latest, namespace: { ...latest.namespace, controlAdmissionClosed: true as const },
        });
        return [...current.controls];
      });
      const outcomes = await Promise.allSettled(controls);
      row = await this.read(policy, row.subject.operationId);
      // Cleanup and qualification are separate facts. An early real Stop or
      // rejected recipe can still close its exact physical scope positively.
      // Preserve/ACK that actual closure without claiming the recipe passed.
      const recipeObserved = closed.state === "closed" && closed.admission && closed.reason === "user_stop" &&
        row.namespace?.payloadReady && row.namespace.stopRequested && row.namespace.stopControlSettled;
      if (outcomes.some(outcome => outcome.status !== "fulfilled")) throw unavailable();
      const receiptSha256 = await qualificationDigest(closed);
      row = await this.patchNamespace(policy, row, { receipt: closed, receiptSha256 });
      const persisted = await this.read(policy, row.subject.operationId);
      if (!persisted.namespace?.receipt || await qualificationDigest(persisted.namespace.receipt) !== receiptSha256) throw unavailable();
      if (!row.namespace?.identity) throw unavailable();
      await sandbox.qualificationNamespaceControl(auth, binding, nonce, intent.controlToken, row.namespace.identity, "ack");
      const final = QualificationNamespaceReceiptSchema.parse(await original);
      if (await qualificationDigest(final) !== receiptSha256) throw unavailable();
      if (!recipeObserved) {
        row = await this.transition(policy, row, "namespace_closed", { namespace: { originalTransportSettled: true },
          originalTransportSettled: true, failureCode: "QUALIFICATION_RECIPE_INCOMPLETE" });
        return this.publicRecord(row);
      }
      row = await this.transition(policy, row, "qualifying_verify", { namespace: { originalTransportSettled: true } });
      const markers = QualificationMarkersSchema.parse(await sandbox.qualificationFixture(auth, { binding, nonce, fixture }, "observe"));
      if (JSON.stringify(markers.binding) !== JSON.stringify(binding) || markers.nonce !== nonce || JSON.stringify(markers.fixture) !== JSON.stringify(fixture) ||
        new Set(markers.markers.map(marker => marker.name)).size !== 3) throw unavailable();
      row = await this.transition(policy, row, "namespace_observed", { namespace: { markers }, originalTransportSettled: true });
      return this.publicRecord(row);
    } catch {
      // A deadline/missing port/failed Stop never proves closure and never
      // destroys the Sandbox. The original and its exact control loans remain.
      if (row.namespace && current && row.originalId === current.id) {
        try { await this.stopNamespace(auth, policy, row.subject.operationId); } catch { /* Retain unknown. */ }
      }
      await this.unknown(policy, row);
      throw unavailable();
    }
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
    const original = Object.freeze({ id, promise, launch, controls: new Set<Promise<unknown>>(), resources: {} });
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
        expiresAt: Date.now() + 10 * 60_000,
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
  private async transition(policy: QualificationPolicy, row: QualificationRecord, phase: QualificationRecord["phase"],
    patch: Omit<Partial<QualificationRecord>, "namespace"> & {
      namespace?: Partial<Omit<NonNullable<QualificationRecord["namespace"]>, "nonce" | "controlToken" | "stopRequested" | "stopControlSettled" | "controlAdmissionClosed">>;
    } = {}): Promise<QualificationRecord> {
    return this.state.blockConcurrencyWhile(async () => {
      const current = await this.read(policy, row.subject.operationId);
      if (current.phase !== row.phase || current.authorityDigest !== row.authorityDigest ||
        current.originalId !== row.originalId || this.original?.id !== row.originalId) throw unavailable();
      if (patch.namespace && !current.namespace) throw unavailable();
      const next: QualificationRecord = { ...current, ...patch, phase, rawDispatched: undefined,
        namespace: current.namespace ? { ...current.namespace, ...patch.namespace } : undefined };
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
      namespace: row.namespace ? { nonce: row.namespace.nonce, fixture: row.namespace.fixture, identity: row.namespace.identity,
        payloadReady: row.namespace.payloadReady === true, stopRequested: row.namespace.stopRequested === true,
        stopControlSettled: row.namespace.stopControlSettled === true, originalTransportSettled: row.namespace.originalTransportSettled === true,
        receipt: row.namespace.receipt, receiptSha256: row.namespace.receiptSha256, markers: row.namespace.markers } : undefined,
      active: row.phase !== "retired", runtimeQualified: false as const };
  }
}
function unavailable(): Error { return new Error("NATIVE_QUALIFICATION_ORIGINAL_OR_AUTHORITY_UNAVAILABLE"); }

function rawPhase(action: QualificationRawAction): QualificationRecord["phase"] {
  return ({ observe: "starting", provision: "provisioning", retire: "retiring", fixture: "qualifying_fixture",
    namespace: "qualifying_namespace", verify: "qualifying_verify" } as const)[action];
}
function qualificationPause(): Promise<void> { return new Promise(resolve => setTimeout(resolve, 100)); }
