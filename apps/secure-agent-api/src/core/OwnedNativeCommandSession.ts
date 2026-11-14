import path from "node:path";
import type { ArtifactStorePort } from "../ports/ArtifactStorePort";
import type { SandboxExecutionLease } from "../ports/SandboxExecutionLease";
import {
  NativeCommandReceiptSchema, NativeCommandRequestSchema, NativeMetadataProtectionSchema,
  sameNativeBinding, sameNativeIdentity,
  type NativeCommandBinding, type NativeCommandCapability, type NativeCommandIdentity,
  type NativeCommandOriginal, type NativeCommandReceipt, type NativeCommandRequest,
  type NativeCommandSpec, type NativeMetadataProtection, type NativeRootIdentity,
  type OwnedNativeSandboxPort,
} from "../toolbox/contracts/OwnedSandboxCommand";

export interface NativeCommandIntent {
  kind: "workspace_prepare" | "command";
  binding: NativeCommandBinding;
  phase: "dispatching" | "prepared" | "gate_dispatching" | "scope_closed" | "settled" | "unknown";
  controlToken: string;
  request?: NativeCommandRequest;
  identity?: NativeCommandIdentity;
  receipt?: Omit<NativeCommandReceipt, "stdout" | "stderr">;
  receiptArtifact?: { id: string; sha256: string; size: number };
  originalTransportSettled?: true;
  stopRequested?: true;
}
export interface NativeSessionFields {
  nativeWorkspace?: { root: NativeRootIdentity; metadata: NativeMetadataProtection };
  nativeCommand?: NativeCommandIntent;
}
interface Session extends NativeSessionFields {
  lease: SandboxExecutionLease;
  workspaceScope: SandboxExecutionLease["workspaceScope"];
  cleanupInProgress?: boolean;
}
const prefix = "execution:session:";

/** Same persisted execution session and physical writer; no parallel lifecycle. */
export class OwnedNativeCommandSession implements NativeCommandCapability {
  private original: Promise<NativeCommandOriginal> | undefined;
  private stopped = false;

  constructor(private readonly input: {
    state: DurableObjectState; sessionId: string; lease: SandboxExecutionLease; taskId: string;
    sandbox: OwnedNativeSandboxPort; artifacts: ArtifactStorePort;
  }) {}

  async prepareWorkspace(value: NativeMetadataProtection): Promise<NativeRootIdentity> {
    const metadata = NativeMetadataProtectionSchema.parse(value);
    const intent = this.intent("workspace_prepare");
    await this.reserve(intent);
    try {
      const root = await this.input.sandbox.prepareNativeWorkspace({
        binding: intent.binding, root: this.input.lease.workspaceScope.root, metadata,
      });
      await this.update(intent.binding.nonce, session => ({ ...session,
        nativeWorkspace: { root, metadata },
        nativeCommand: { ...intent, phase: "settled", originalTransportSettled: true },
      }));
      return root;
    } catch {
      await this.markUnknown(intent.binding.nonce);
      throw unavailable();
    }
  }

  async execute(spec: NativeCommandSpec) {
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
        if (this.stopped || (await this.read()).nativeCommand?.stopRequested) {
          await this.control(intent, "stop");
        } else if (receipt.state === "prepared") {
          // Do not retry this request if its response is lost. Persisted intent
          // plus subsequent status observation determines what actually happened.
          const current = await this.read();
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
        (receipt.admission && (!receipt.identity || !intent.identity))) throw unavailable();
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
      await this.patch(intent.binding.nonce, { phase: "settled", originalTransportSettled: true });
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

  async stop(): Promise<boolean> {
    this.stopped = true;
    const session = await this.read();
    const intent = session.nativeCommand;
    if (!intent || intent.phase === "settled") return true;
    if (intent.binding.taskId !== this.input.taskId) return false;
    await this.patch(intent.binding.nonce, { stopRequested: true });
    if (intent.kind === "command") {
      try { await this.control(intent, "stop"); } catch { return false; }
    }
    return await this.awaitClosure();
  }

  async awaitClosure(): Promise<boolean> {
    const intent = (await this.read()).nativeCommand;
    return !this.original && (!intent || (intent.phase === "settled" && intent.originalTransportSettled === true));
  }

  private intent(kind: NativeCommandIntent["kind"]): NativeCommandIntent {
    const lease = this.input.lease;
    return {
      kind, phase: "dispatching", controlToken: randomHex(),
      binding: { sessionId: this.input.sessionId, leaseId: lease.leaseId, sandboxId: lease.sandboxId, generation: lease.generation,
        workspaceId: lease.workspaceScope.workspaceId, runId: lease.workspaceScope.runId,
        threadId: lease.workspaceScope.threadId, turnId: lease.workspaceScope.turnId,
        runAttemptId: lease.workspaceScope.runAttemptId, taskId: this.input.taskId, nonce: randomHex() },
    };
  }
  private async reserve(intent: NativeCommandIntent): Promise<void> {
    await this.input.state.blockConcurrencyWhile(async () => {
      const session = await this.read();
      const sessions = await this.input.state.storage.list<Session>({ prefix });
      if ([...sessions.values()].some(value => value.lease.sandboxId === this.input.lease.sandboxId && hasUnsettledNativeCommand(value))) throw unavailable();
      await this.input.state.storage.put(prefix + this.input.sessionId, { ...session, nativeCommand: intent });
    });
  }
  private async read(): Promise<Session> {
    const session = await this.input.state.storage.get<Session>(prefix + this.input.sessionId);
    if (!session || session.cleanupInProgress || !sameExecutionLease(session.lease, this.input.lease) ||
      !sameWorkspaceScope(session.workspaceScope, this.input.lease.workspaceScope)) throw unavailable();
    return session;
  }
  private async update(nonce: string, change: (session: Session) => Session): Promise<void> {
    await this.input.state.blockConcurrencyWhile(async () => {
      const session = await this.read();
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
    if (identity.root.device !== request.expectedRoot.device || identity.root.inode !== request.expectedRoot.inode ||
      identity.metadataIdentity !== request.metadata.identity || JSON.stringify(identity.limits) !== JSON.stringify(request.limits)) throw unavailable();
  }
}

export function hasUnsettledNativeCommand(session: NativeSessionFields): boolean {
  return !!session.nativeCommand && (session.nativeCommand.phase !== "settled" || session.nativeCommand.originalTransportSettled !== true);
}
export function sameExecutionLease(actual: SandboxExecutionLease, expected: SandboxExecutionLease): boolean {
  return actual.leaseId === expected.leaseId && actual.sandboxId === expected.sandboxId && actual.owner === expected.owner &&
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
