import { NativeCheckoutBootstrapIntentSchema, NativeCheckoutBootstrapReceiptSchema, freezeBootstrap,
  type NativeCheckoutBootstrapIntent, type NativeCheckoutBootstrapReceipt, type NativeCheckoutReadyEvidence } from "@repo/worker-protocol/private/native-checkout-bootstrap";
import path from "node:path";
import type { ArtifactStorePort } from "../ports/ArtifactStorePort";
import type { SandboxExecutionLease } from "../ports/SandboxExecutionLease";
import type { GitRepositoryMetadataPaths } from "@repo/git-service";
import { NativeCommandClosureSchema, NativeCommandScopeSchema, type NativeCommandClosure, type NativeCommandScope } from "@repo/shared-types/native-command-closure";
import { validExecutionDomain, type ExecutionDomainSessionFields } from "./ExecutionSessionDomain";
import {
  NativeCommandReceiptSchema, NativeCommandRequestSchema, NativeWorkspaceStateSchema, NativeWorkspaceWriteReceiptSchema,
  sameNativeBinding, sameNativeIdentity,
  type NativeCommandBinding, type NativeCommandCapability, type NativeCommandIdentity,
  type NativeCommandOriginal, type NativeCommandReceipt, type NativeCommandRequest,
  type NativeCommandSpec, type NativeRootIdentity,
  type NativeWorkspaceState, type NativeWorkspaceWriteReceipt,
  type OwnedNativeSandboxPort,
} from "../toolbox/contracts/OwnedSandboxCommand";

export interface NativeCommandIntent {
  kind: "workspace_prepare" | "file_write" | "command";
  binding: NativeCommandBinding;
  phase: "dispatching" | "prepared" | "gate_dispatching" | "scope_closed" | "settled" | "unknown";
  controlToken: string;
  request?: NativeCommandRequest;
  identity?: NativeCommandIdentity;
  receipt?: Omit<NativeCommandReceipt, "stdout" | "stderr">;
  receiptArtifact?: { id: string; sha256: string; size: number };
  originalTransportSettled?: true;
  stopRequested?: true;
  writeReceipt?: NativeWorkspaceWriteReceipt;
  writeIntent?: { path: string; bytes: number; sha256: string };
}
export interface NativeCheckoutState {
  intent: NativeCheckoutBootstrapIntent;
  phase: "reserved" | "dispatching" | "materialized" | "unknown";
  receipt?: NativeCheckoutBootstrapReceipt;
  artifact?: { id: string; sha256: string; size: number };
  runtime?: NativeCheckoutReadyEvidence["runtime"];
  rawStarted?: true;
}
export interface NativeSessionFields {
  nativeCheckout?: NativeCheckoutState;
  nativeWorkspace?: NativeWorkspaceState;
  nativeCommand?: NativeCommandIntent;
}
interface Session extends NativeSessionFields, ExecutionDomainSessionFields {
  lease: SandboxExecutionLease;
  workspaceScope: SandboxExecutionLease["workspaceScope"];
  cleanupInProgress?: boolean;
  expiresAt?: number;
}
/** Trusted bootstrap transport/FD settlement is not untrusted containment closure. */
export interface NativeBootstrapTransportSettlement {
  readonly kind: "bootstrap_transport";
  readonly receipt: NativeCheckoutBootstrapReceipt;
  readonly artifact: Readonly<{ id: string; sha256: string; size: number }>;
}
const prefix = "execution:session:";

/** Same persisted execution session and physical writer; no parallel lifecycle. */
export class OwnedNativeCommandSession implements NativeCommandCapability {
  private original: Promise<unknown> | undefined;
  private readonly operations = new Set<Promise<unknown>>();
  private stopped = false;
  private settledBootstrap?: NativeBootstrapTransportSettlement;
  // Evidence belongs to this retained original task, never to whichever task
  // later occupies the session's current command slot. Keep its immutable R2
  // reference alongside the exact physical receipt until this owner releases.
  private settledOriginal?: Readonly<{
    closure: NativeCommandClosure;
    artifact: Readonly<NonNullable<NativeCommandIntent["receiptArtifact"]>>;
  }>;

  constructor(private readonly input: {
    state: DurableObjectState; sessionId: string; lease: SandboxExecutionLease; taskId: string;
    sandbox: OwnedNativeSandboxPort; artifacts: ArtifactStorePort;
  }) {}

  /** One-shot materialization of the plan admitted by the original session API.
   * The Git credential owner supplies only its private canonical Git environment. */
  materializeCheckout(authEnvironment?: Readonly<Record<string, string>>) {
    return this.track(async () => {
      const session = await this.read();
      const checkout = session.nativeCheckout;
      const materialize = this.input.sandbox.materializeNativeCheckout;
      if (!checkout || checkout.phase !== "reserved" || !materialize) throw unavailable();
      const intent = freezeBootstrap(NativeCheckoutBootstrapIntentSchema.parse(checkout.intent));
      if (intent.root !== this.input.lease.workspaceScope.root) throw unavailable();
      const command = this.intent("workspace_prepare");
      await this.reserve(command);
      await this.update(command.binding.nonce, current => {
        if (current.nativeCheckout?.phase !== "reserved" || JSON.stringify(current.nativeCheckout.intent) !== JSON.stringify(intent)) throw unavailable();
        return { ...current, nativeCheckout: { intent, phase: "dispatching" } };
      });
      try {
        if (this.stopped || (await this.read()).nativeCommand?.stopRequested) throw unavailable();
        const original = materialize.call(this.input.sandbox, { binding: command.binding, intent, authEnvironment, physicalOwnerId: this.input.state.id.toString() });
        this.original = original;
        const completed = await original;
        if (this.stopped || (await this.read()).nativeCommand?.stopRequested) throw unavailable();
        const receipt = freezeBootstrap(NativeCheckoutBootstrapReceiptSchema.parse(completed.receipt));
        const workspace = NativeWorkspaceStateSchema.parse(completed.workspace);
        if (!sameNativeBinding(receipt.observation.binding, command.binding) || JSON.stringify(receipt.intent) !== JSON.stringify(intent) ||
          workspace.root.device !== receipt.observation.root.device || workspace.root.inode !== receipt.observation.root.inode ||
          workspace.sandboxBootId !== receipt.observation.sandboxBootId || workspace.metadata.identity !== receipt.metadataIdentity) throw unavailable();
        const bytes = new TextEncoder().encode(JSON.stringify(receipt)), sha256 = await digest(bytes);
        const uploaded = await this.input.artifacts.upload({ sessionId: this.input.sessionId, contentType: "application/json", data: bytes });
        const stored = await this.input.artifacts.download(uploaded.id, this.input.sessionId);
        if (!stored || stored.byteLength !== bytes.byteLength || await digest(stored) !== sha256) throw unavailable();
        const artifact = { id: uploaded.id, sha256, size: bytes.byteLength };
        await this.update(command.binding.nonce, current => {
          // Recheck after artifact I/O, inside the same serialized write that
          // publishes materialization. Never overwrite a concurrent Stop fence.
          if (this.stopped || current.cleanupInProgress || current.nativeCommand?.stopRequested ||
            current.nativeCommand?.phase !== "dispatching" || current.nativeCheckout?.phase !== "dispatching" ||
            JSON.stringify(current.nativeCheckout.intent) !== JSON.stringify(intent) ||
            current.expiresAt === undefined || current.expiresAt <= Date.now() || current.lease.expiresAt <= Date.now()) throw unavailable();
          return { ...current, nativeWorkspace: workspace,
            nativeCheckout: { ...current.nativeCheckout, phase: "materialized", receipt, artifact },
            nativeCommand: { ...current.nativeCommand, phase: "settled", originalTransportSettled: true } };
        });
        this.settledBootstrap = freezeBootstrap({ kind: "bootstrap_transport", receipt, artifact });
        this.original = undefined;
        return receipt;
      } catch {
        await this.update(command.binding.nonce, current => ({ ...current,
          nativeCheckout: { ...current.nativeCheckout, intent, phase: "unknown" }, nativeCommand: { ...current.nativeCommand!, phase: "unknown" } }));
        throw unavailable();
      }
    });
  }

  prepareWorkspace(metadataPaths: GitRepositoryMetadataPaths): Promise<NativeRootIdentity> {
    return this.track(() => this.prepareOwnedWorkspace(metadataPaths));
  }

  private async prepareOwnedWorkspace(metadataPaths: GitRepositoryMetadataPaths): Promise<NativeRootIdentity> {
    if (this.stopped || this.original) throw unavailable();
    if (metadataPaths.workspaceRoot !== this.input.lease.workspaceScope.root) throw unavailable();
    const intent = this.intent("workspace_prepare");
    await this.reserve(intent);
    try {
      const prepared = await this.input.sandbox.prepareNativeWorkspace({
        binding: intent.binding, root: this.input.lease.workspaceScope.root, metadataPaths,
      });
      await this.update(intent.binding.nonce, session => ({ ...session,
        nativeWorkspace: { root: prepared.root, sandboxBootId: prepared.sandboxBootId, metadata: prepared.metadata },
        nativeCommand: { ...intent, phase: "settled", originalTransportSettled: true },
      }));
      return prepared.root;
    } catch {
      await this.markUnknown(intent.binding.nonce);
      throw unavailable();
    }
  }

  execute(spec: NativeCommandSpec) { return this.track(() => this.executeOwned(spec)); }

  private async executeOwned(spec: NativeCommandSpec) {
    if (this.stopped || this.original) throw unavailable();
    const session = await this.read();
    if (!session.nativeWorkspace) throw new Error("NATIVE_WORKSPACE_PROTECTION_REQUIRED");
    const intent = this.intent("command");
    const root = this.input.lease.workspaceScope.root;
    const cwd = path.posix.relative(root, spec.cwd ?? root) || ".";
    if (cwd === ".." || cwd.startsWith("../") || path.posix.isAbsolute(cwd)) throw unavailable();
    const environment = Object.fromEntries(Object.entries(spec.env ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const request = NativeCommandRequestSchema.parse({
      version: 1, binding: intent.binding, controlToken: intent.controlToken,
      root, expectedRoot: session.nativeWorkspace.root, metadata: session.nativeWorkspace.metadata,
      expectedBootId: session.nativeWorkspace.sandboxBootId,
      cwd, argv: spec.argv, environment, timeoutMs: spec.timeoutMs ?? 30_000,
      outputLimit: 4 * 1024 * 1024,
      limits: { memoryBytes: 512 * 1024 * 1024, pids: 128, cpuQuotaMicros: 100_000, cpuPeriodMicros: 100_000 },
    });
    if (new TextEncoder().encode(JSON.stringify(request)).byteLength > 64 * 1024) throw unavailable();
    intent.request = request;
    await this.reserve(intent); // Durable intent precedes any physical launch.
    const original = this.input.sandbox.executeNativeCommand(request);
    this.original = original;
    let originalOutcome: PromiseSettledResult<NativeCommandOriginal> | undefined;
    void original.then(value => { originalOutcome = { status: "fulfilled", value }; }, reason => { originalOutcome = { status: "rejected", reason }; });
    try {
      let receipt: NativeCommandReceipt | undefined;
      const deadline = Date.now() + request.timeoutMs + 20_000;
      while (Date.now() < deadline) {
        if (originalOutcome) throw unavailable(); // Cannot replace the original loan after failure.
        try { receipt = await this.control(intent, "status"); }
        catch { await pause(); continue; }
        if (receipt.state === "unknown") throw unavailable();
        if (receipt.identity && !intent.identity) {
          this.assertPreparedIdentity(request, receipt.identity);
          intent.identity = receipt.identity;
          await this.patch(intent.binding.nonce, { identity: intent.identity, phase: "prepared" });
        }
        if (intent.identity && (!receipt.identity || !sameNativeIdentity(intent.identity, receipt.identity))) throw unavailable();
        if (this.stopped || (await this.read(true)).cleanupInProgress || (await this.read(true)).nativeCommand?.stopRequested) {
          await this.control(intent, "stop");
        } else if (receipt.state === "prepared") {
          // Do not retry this request if its response is lost. Persisted intent
          // plus subsequent status observation determines what actually happened.
          const current = await this.read(true);
          if (originalOutcome) throw unavailable();
          if (current.nativeCommand?.phase !== "gate_dispatching") {
            await this.patch(intent.binding.nonce, { phase: "gate_dispatching" });
            try { await this.control(intent, "start"); } catch { /* Observe the same gate; never redispatch it. */ }
          }
        }
        if (receipt.state === "closed" || receipt.state === "not_started") break;
        await pause();
      }
      if (!receipt || (receipt.state !== "closed" && receipt.state !== "not_started") || !receipt.gateClosed ||
        !receipt.identity || !intent.identity) throw unavailable();
      const bytes = new TextEncoder().encode(JSON.stringify(receipt));
      const sha256 = await digest(bytes);
      const artifact = await this.input.artifacts.upload({
        sessionId: this.input.sessionId, contentType: "application/json", data: bytes,
        metadata: { kind: "native-command-receipt", nonce: intent.binding.nonce, sha256 },
      });
      const persisted = await this.input.artifacts.download(artifact.id, this.input.sessionId);
      if (!persisted || await digest(persisted) !== sha256) throw unavailable();
      const { stdout: _stdout, stderr: _stderr, ...smallReceipt } = receipt;
      await this.patch(intent.binding.nonce, {
        phase: "scope_closed", receipt: smallReceipt,
        receiptArtifact: { id: artifact.id, sha256, size: bytes.byteLength },
      });
      await this.control(intent, "ack");
      const result = await original;
      if (result.exitCode !== 0 || result.stderr !== "") throw unavailable();
      const final = NativeCommandReceiptSchema.parse(JSON.parse(result.stdout));
      if (await digest(new TextEncoder().encode(JSON.stringify(final))) !== sha256) throw unavailable();
      await this.input.state.blockConcurrencyWhile(async () => {
        const current = await this.read(true);
        if (current.nativeCommand?.binding.nonce !== intent.binding.nonce) throw unavailable();
        const settled = { ...current, nativeCommand: { ...current.nativeCommand,
          phase: "settled" as const, originalTransportSettled: true as const } };
        const closure = nativeClosureEvidence(this.input.sessionId, this.input.lease, this.input.taskId, settled);
        if (closure?.state !== "settled" || !settled.nativeCommand.receiptArtifact) throw unavailable();
        await this.input.state.storage.put(prefix + this.input.sessionId, settled);
        this.settledOriginal = Object.freeze({
          closure: freezeOriginalEvidence(closure),
          artifact: Object.freeze({ ...settled.nativeCommand.receiptArtifact }),
        });
      });
      this.original = undefined;
      return {
        exitCode: receipt.exitCode ?? (receipt.admission ? 1 : 126),
        stdout: decodeOutput(receipt.stdout), stderr: decodeOutput(receipt.stderr),
      };
    } catch {
      await this.markUnknown(intent.binding.nonce);
      // Keep the original promise pinned. Losing a response or restarting an
      // isolate never creates proof of original EOF or permission to rerun.
      throw unavailable();
    }
  }

  writeFile(target: string, content: string, options: { exclusive?: boolean } = {}): Promise<void> {
    return this.track(() => this.writeOwnedFile(target, content, options));
  }

  private async writeOwnedFile(target: string, content: string, options: { exclusive?: boolean }): Promise<void> {
    if (this.stopped || this.original) throw unavailable();
    const write = this.input.sandbox.writeNativeWorkspaceFile;
    if (typeof write !== "function") throw unavailable();
    const session = await this.read();
    if (!session.nativeWorkspace) throw unavailable();
    const relative = path.posix.relative(this.input.lease.workspaceScope.root, target);
    const bytes = new TextEncoder().encode(content);
    if (!relative || relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative) || bytes.byteLength > 200_000) throw unavailable();
    const intent = this.intent("file_write");
    intent.writeIntent = { path: relative, bytes: bytes.byteLength, sha256: await digest(bytes) };
    await this.reserve(intent);
    const original = write.call(this.input.sandbox, {
      binding: intent.binding, root: this.input.lease.workspaceScope.root,
      expectedRoot: session.nativeWorkspace.root, expectedBootId: session.nativeWorkspace.sandboxBootId,
      metadata: session.nativeWorkspace.metadata, path: relative, content, exclusive: options.exclusive === true,
    });
    this.original = original;
    try {
      const receipt = await original;
      if (!sameNativeBinding(receipt.binding, intent.binding) || receipt.root.device !== session.nativeWorkspace.root.device ||
        receipt.root.inode !== session.nativeWorkspace.root.inode || receipt.sandboxBootId !== session.nativeWorkspace.sandboxBootId ||
        receipt.metadataIdentity !== session.nativeWorkspace.metadata.identity || receipt.path !== relative ||
        receipt.bytes !== bytes.byteLength || receipt.sha256 !== intent.writeIntent.sha256) throw unavailable();
      await this.patch(intent.binding.nonce, { phase: "settled", originalTransportSettled: true, writeReceipt: receipt });
      this.original = undefined;
    } catch { await this.markUnknown(intent.binding.nonce); throw unavailable(); }
  }

  async drainOriginalOperations(): Promise<void> {
    // Once the plugin observer settles it cannot create another operation.
    this.stopped = true;
    await Promise.allSettled([...this.operations]);
  }

  async stop(): Promise<boolean> {
    this.stopped = true;
    if (this.settledOriginal && !this.original && this.operations.size === 0) return true;
    const session = await this.read(true);
    const intent = session.nativeCommand;
    if (!intent || intent.phase === "settled") return true;
    if (intent.binding.taskId !== this.input.taskId) return false;
    await this.patch(intent.binding.nonce, { stopRequested: true });
    if (session.nativeCheckout?.phase === "dispatching" || session.nativeCheckout?.phase === "unknown") {
      if (!this.input.sandbox.sealNativeBootstrap) return false;
      try { await this.input.sandbox.sealNativeBootstrap(intent.binding); } catch { return false; }
    }
    if (intent.kind === "command") {
      try { await this.control(intent, "stop"); } catch { return false; }
    }
    return await this.awaitClosure();
  }

  bootstrapTransportSettlement(): NativeBootstrapTransportSettlement | undefined {
    if (this.stopped && !this.original && this.operations.size === 0) return this.settledBootstrap;
    return undefined;
  }

  async awaitClosure(): Promise<boolean> {
    return this.stopped && !this.original && this.operations.size === 0 && this.settledOriginal?.closure.state === "settled";
  }

  async closureEvidence(): Promise<NativeCommandClosure | undefined> {
    if (this.stopped && !this.original && this.operations.size === 0 && this.settledOriginal) return this.settledOriginal.closure;
    // Without the exact retained original snapshot, a different task's latest
    // session slot is not evidence for this task. Recovery stays unknown.
    return nativeClosureEvidence(this.input.sessionId, this.input.lease, this.input.taskId, await this.read(true));
  }

  private intent(kind: NativeCommandIntent["kind"]): NativeCommandIntent {
    const lease = this.input.lease;
    if (!lease.executionDomainDigest) throw unavailable();
    return {
      kind, phase: "dispatching", controlToken: randomHex(),
      binding: { executionDomainDigest: lease.executionDomainDigest, sessionId: this.input.sessionId, leaseId: lease.leaseId, sandboxId: lease.sandboxId, generation: lease.generation,
        workspaceId: lease.workspaceScope.workspaceId, runId: lease.workspaceScope.runId,
        threadId: lease.workspaceScope.threadId, turnId: lease.workspaceScope.turnId,
        runAttemptId: lease.workspaceScope.runAttemptId, taskId: this.input.taskId, nonce: randomHex() },
    };
  }
  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopped || this.original || this.operations.size > 0) return Promise.reject(unavailable());
    this.settledOriginal = undefined;
    this.settledBootstrap = undefined;
    const original = Promise.resolve().then(operation);
    this.operations.add(original);
    const settled = () => { this.operations.delete(original); };
    void original.then(settled, settled);
    return original;
  }
  private async reserve(intent: NativeCommandIntent): Promise<void> {
    await this.input.state.blockConcurrencyWhile(async () => {
      const session = await this.read();
      const sessions = await this.input.state.storage.list<Session>({ prefix });
      if ([...sessions.values()].some(value => value.lease?.sandboxId === this.input.lease.sandboxId && hasUnsettledNativeCommand(value))) throw unavailable();
      await this.input.state.storage.put(prefix + this.input.sessionId, { ...session, nativeCommand: intent });
    });
  }
  private async read(allowClosing = false): Promise<Session> {
    const session = await this.input.state.storage.get<Session>(prefix + this.input.sessionId);
    if (this.input.lease.owner !== this.input.sessionId || !session || (!allowClosing && session.cleanupInProgress) || !sameExecutionLease(session.lease, this.input.lease) ||
      !sameWorkspaceScope(session.workspaceScope, this.input.lease.workspaceScope)) throw unavailable();
    if ((await validExecutionDomain(session))?.domain !== "legioncode_native") throw unavailable();
    return session;
  }
  private async update(nonce: string, change: (session: Session) => Session): Promise<void> {
    await this.input.state.blockConcurrencyWhile(async () => {
      const session = await this.read(true);
      if (session.nativeCommand?.binding.nonce !== nonce) throw unavailable();
      await this.input.state.storage.put(prefix + this.input.sessionId, change(session));
    });
  }
  private patch(nonce: string, patch: Partial<NativeCommandIntent>): Promise<void> {
    return this.update(nonce, session => ({ ...session, nativeCommand: { ...session.nativeCommand!, ...patch } }));
  }
  private markUnknown(nonce: string): Promise<void> { return this.patch(nonce, { phase: "unknown" }); }
  private async control(intent: NativeCommandIntent, action: "status" | "start" | "stop" | "ack") {
    const receipt = await this.input.sandbox.controlNativeCommand({
      action, binding: intent.binding, controlToken: intent.controlToken, identity: intent.identity,
    });
    if (!sameNativeBinding(receipt.binding, intent.binding)) throw unavailable();
    return receipt;
  }
  private assertPreparedIdentity(request: NativeCommandRequest, identity: NativeCommandIdentity): void {
    if (identity.bootId !== request.expectedBootId || identity.root.device !== request.expectedRoot.device || identity.root.inode !== request.expectedRoot.inode ||
      identity.metadataIdentity !== request.metadata.identity || JSON.stringify(identity.limits) !== JSON.stringify(request.limits)) throw unavailable();
  }
}

export function hasUnsettledNativeCommand(session: NativeSessionFields & { lease?: SandboxExecutionLease }): boolean {
  try { return unsettledNativeCommand(session); } catch { return true; }
}
function unsettledNativeCommand(session: NativeSessionFields & { lease?: SandboxExecutionLease }): boolean {
  if (session.nativeCheckout && ["dispatching", "unknown"].includes(session.nativeCheckout.phase)) return true;
  const intent = session.nativeCommand;
  if (!intent) return false;
  if (intent.phase !== "settled" || intent.originalTransportSettled !== true || !session.nativeWorkspace ||
    !NativeWorkspaceStateSchema.safeParse(session.nativeWorkspace).success) return true;
  if (intent.kind === "workspace_prepare") return false;
  if (intent.kind === "file_write") {
    const receipt = intent.writeReceipt, expected = intent.writeIntent;
    return !receipt || !expected || !NativeWorkspaceWriteReceiptSchema.safeParse(receipt).success ||
      !sameNativeBinding(intent.binding, receipt.binding) || receipt.path !== expected.path || receipt.bytes !== expected.bytes ||
      receipt.sha256 !== expected.sha256 || receipt.sandboxBootId !== session.nativeWorkspace.sandboxBootId ||
      receipt.root.device !== session.nativeWorkspace.root.device || receipt.root.inode !== session.nativeWorkspace.root.inode ||
      receipt.metadataIdentity !== session.nativeWorkspace.metadata.identity;
  }
  const identity = intent.identity, request = intent.request, receipt = intent.receipt;
  if (!identity || !request || !receipt || !intent.receiptArtifact || !/^[a-f0-9]{64}$/.test(intent.receiptArtifact.sha256) ||
    !NativeCommandRequestSchema.safeParse(request).success || !NativeCommandReceiptSchema.safeParse(receipt).success || !receipt.gateClosed ||
    (receipt.state !== "closed" && receipt.state !== "not_started") || !receipt.identity ||
    !sameNativeBinding(intent.binding, request.binding) || !sameNativeBinding(intent.binding, receipt.binding) ||
    !sameNativeIdentity(identity, receipt.identity) || identity.bootId !== request.expectedBootId ||
    identity.root.device !== request.expectedRoot.device || identity.root.inode !== request.expectedRoot.inode ||
    identity.metadataIdentity !== request.metadata.identity || JSON.stringify(identity.limits) !== JSON.stringify(request.limits) ||
    identity.bootId !== session.nativeWorkspace.sandboxBootId || identity.metadataIdentity !== session.nativeWorkspace.metadata.identity ||
    identity.root.device !== session.nativeWorkspace.root.device || identity.root.inode !== session.nativeWorkspace.root.inode) return true;
  const lease = session.lease;
  return !!lease && (intent.binding.executionDomainDigest !== lease.executionDomainDigest || intent.binding.sessionId !== lease.owner || intent.binding.leaseId !== lease.leaseId ||
    intent.binding.sandboxId !== lease.sandboxId || intent.binding.generation !== lease.generation ||
    intent.binding.workspaceId !== lease.workspaceScope.workspaceId || intent.binding.runId !== lease.workspaceScope.runId ||
    intent.binding.threadId !== lease.workspaceScope.threadId || intent.binding.turnId !== lease.workspaceScope.turnId ||
    intent.binding.runAttemptId !== lease.workspaceScope.runAttemptId || request.root !== lease.workspaceScope.root);
}
export function nativeClosureEvidence(sessionId: string, lease: SandboxExecutionLease, taskId: string, session: NativeSessionFields & ExecutionDomainSessionFields): NativeCommandClosure | undefined {
  const intent = session.nativeCommand;
  if (!intent || intent.kind !== "command" || intent.binding.taskId !== taskId || !lease.executionDomainDigest || session.executionDomain?.domain !== "legioncode_native") return undefined;
  const scope = nativeCommandScope(sessionId, lease, taskId);
  if (!scope) return undefined;
  const identity = intent.identity;
  if (hasUnsettledNativeCommand({ ...session, lease }) || intent.binding.sessionId !== sessionId || !identity || !intent.receiptArtifact ||
    !intent.receipt?.gateClosed || !intent.request || !sameNativeBinding(intent.binding, intent.request.binding) ||
    !sameNativeBinding(intent.binding, intent.receipt.binding) || !intent.receipt.identity || !sameNativeIdentity(identity, intent.receipt.identity) ||
    (intent.receipt.state !== "closed" && intent.receipt.state !== "not_started")) {
    return NativeCommandClosureSchema.parse({ state: "unknown", scope, operationId: intent.binding.nonce, originalTransportSettled: false });
  }
  return NativeCommandClosureSchema.parse({ state: "settled", scope,
    profile: "linux-pid-namespace-cgroup-v2",
    operationId: intent.binding.nonce, nonce: intent.binding.nonce, originalTransportSettled: true,
    root: identity.root, sandboxBootId: identity.bootId,
    namespace: { device: identity.namespaceDevice, inode: identity.namespaceInode, initHostPid: identity.initHostPid },
    cgroup: identity.cgroup, metadataIdentity: identity.metadataIdentity, receiptSha256: intent.receiptArtifact.sha256 });
}
export function nativeCommandScope(sessionId: string, lease: SandboxExecutionLease, taskId: string): NativeCommandScope | undefined {
  if (!lease.executionDomainDigest) return undefined;
  return NativeCommandScopeSchema.parse({ executionDomainDigest: lease.executionDomainDigest,
    sessionId, leaseId: lease.leaseId, sandboxId: lease.sandboxId, generation: lease.generation,
    workspaceId: lease.workspaceScope.workspaceId, workspaceRoot: lease.workspaceScope.root,
    runId: lease.workspaceScope.runId, threadId: lease.workspaceScope.threadId,
    turnId: lease.workspaceScope.turnId, runAttemptId: lease.workspaceScope.runAttemptId, taskId });
}
function freezeOriginalEvidence<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeOriginalEvidence(child);
    Object.freeze(value);
  }
  return value;
}
export function sameExecutionLease(actual: SandboxExecutionLease, expected: SandboxExecutionLease): boolean {
  return actual.leaseId === expected.leaseId && actual.sandboxId === expected.sandboxId && actual.owner === expected.owner &&
    actual.executionDomainDigest === expected.executionDomainDigest &&
    actual.generation === expected.generation && actual.correlationId === expected.correlationId &&
    actual.expiresAt === expected.expiresAt && actual.mutationMode === expected.mutationMode &&
    sameWorkspaceScope(actual.workspaceScope, expected.workspaceScope);
}
function sameWorkspaceScope(actual: SandboxExecutionLease["workspaceScope"], expected: SandboxExecutionLease["workspaceScope"]): boolean {
  return Object.keys(expected).every(key => actual[key as keyof typeof actual] === expected[key as keyof typeof expected]);
}
function randomHex(): string { return [...crypto.getRandomValues(new Uint8Array(32))].map(value => value.toString(16).padStart(2, "0")).join(""); }
async function digest(value: Uint8Array): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", value))].map(byte => byte.toString(16).padStart(2, "0")).join(""); }
function decodeOutput(value: string | undefined): string {
  if (!value) return "";
  const binary = atob(value);
  return new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)));
}
function pause(): Promise<void> { return new Promise(resolve => setTimeout(resolve, 100)); }
function unavailable(): Error { return new Error("NATIVE_COMMAND_CLOSURE_UNAVAILABLE"); }
