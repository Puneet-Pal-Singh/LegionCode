import { snapshotNativeSandboxPhysicalBinding, type NativeSandboxPhysicalBinding } from "@repo/worker-protocol/private/native-sandbox-binding";
import { selectNativeSandboxBinding, resolveNativeSandbox } from "./OriginalSandboxResolver";
import { CloudflareArtifactStoreAdapter } from "../adapters/CloudflareArtifactStoreAdapter";
import { NativeCheckoutBootstrapIntentSchema, parseNativeCheckoutReadyEvidence, freezeBootstrap,
  type NativeCheckoutBootstrapIntent } from "@repo/worker-protocol/private/native-checkout-bootstrap";
import { NativeCommandBindingSchema, NativeWorkspaceStateSchema, sameNativeBinding } from "../toolbox/contracts/OwnedSandboxCommand";
// apps/secure-agent-api/src/core/AgentRuntime.ts
// RECONSTRUCTABILITY: Execution sessions and logs exist only in DO storage.
// Chat history is dual-written to DO (runtime cache) and Postgres
// (via agent/brain -> PostgresTranscriptRepository). If DO storage is
// lost, active execution sessions fail (expected), but historical chat
// messages can be reloaded from Postgres. Execution logs are ephemeral
// debugging state with no Postgres equivalent.
import { DurableObject } from "cloudflare:workers";
import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import { IPlugin, Message } from "../interfaces/types";
import { StreamHandler } from "./StreamHandler";
import { StorageService } from "../services/StorageService";
import { PythonPlugin } from "../plugins/PythonPlugin";
import { RedisPlugin } from "../plugins/RedisPlugin";
import { FileSystemPlugin } from "../plugins/FileSystemPlugin";
import { GitPlugin } from "../plugins/GitPlugin";
import { GitHubPlugin } from "../plugins/GitHubPlugin";
import { GitHubCliPlugin } from "../plugins/GitHubCliPlugin";
import { BashPlugin } from "../plugins/BashPlugin";
import { NodePlugin } from "../plugins/NodePlugin";
import { RustPlugin } from "../plugins/RustPlugin";
import { Env } from "../index";
import {
  composeRuntime,
  type ComposedRuntime,
  type ComposeRuntimeInput,
} from "../factories/RuntimeCompositionFactory";
import type {
  TaskExecutionHooks,
  TaskExecutionInput,
  TaskExecutionResult,
} from "../ports/SandboxExecutionPort";
import {
  workspaceLeaseKey,
  sameSandboxExecutionLease,
  type SandboxExecutionLease,
} from "../ports/SandboxExecutionLease";
import type { DurableObjectState as LegacyDurableObjectState } from "@cloudflare/workers-types";
import { OwnedNativeCommandSession, hasUnsettledNativeCommand, nativeClosureEvidence, nativeCommandScope, sameExecutionLease, type NativeSessionFields } from "./OwnedNativeCommandSession";
import type { OwnedNativeSandboxPort } from "../toolbox/contracts/OwnedSandboxCommand";
import { assertExecutionDomainAdmission, isRetiredExecutionSession, retiredExecutionBinding, validExecutionDomain, hasExecutionDomain,
  type ExecutionDomainSessionFields, type RetiredExecutionSessionRecord } from "./ExecutionSessionDomain";
import { parseNativeCommandClosure } from "@repo/shared-types/native-command-closure";
import { snapshotExecutionDomain } from "@repo/worker-protocol/private/execution-domain";

import { NativeBoundaryQualificationOwner } from "../qualification/NativeBoundaryQualificationOwner";
import { isQualificationEnvironment, type QualificationAuthorization } from "../qualification/NativeBoundaryQualificationAuth";
import { isQualificationRecord, type QualificationRecord, type QualificationCommand, type ResourceSetupBinding, type QualificationRawAction } from "../qualification/contracts";

interface RuntimeSessionRecord extends NativeSessionFields, ExecutionDomainSessionFields {
  nativeCheckoutIntent?: NativeCheckoutBootstrapIntent;
  runId: string;
  taskId: string;
  repoPath: string;
  expiresAt: number;
  token: string;
  createdAt: number;
  workspaceScope: {
    runId: string;
    threadId: string;
    turnId: string;
    runAttemptId: string;
    workspaceId: string;
    root: string;
  };
  lease: SandboxExecutionLease;
  cleanupAttempts?: number;
  cleanupFailureCode?: "SANDBOX_CLEANUP_FAILED" | "ORIGINAL_COMMAND_CLOSURE_UNKNOWN";
  cleanupRetryAt?: number;
  cleanupInProgress?: boolean;
}

type PhysicalExecutionSessionRecord = RuntimeSessionRecord | RetiredExecutionSessionRecord | QualificationRecord;

interface WorkspaceRuntimeEntry {
  readonly lease: SandboxExecutionLease;
  readonly composed: ComposedRuntime;
  readonly sandbox: Sandbox;
  readonly nativeSandboxBinding?: NativeSandboxPhysicalBinding;
  readonly plugins: Map<string, IPlugin>;
  pluginsBooted: boolean;
  pluginBootPromise?: Promise<void>;
}

interface RuntimeSessionLogEntry {
  taskId?: string;
  timestamp: number;
  level: "info" | "warn" | "error" | "debug";
  message: string;
  source?: "stdout" | "stderr";
}

const EXECUTION_SESSION_KEY_PREFIX = "execution:session:";
const EXECUTION_LOG_KEY_PREFIX = "execution:logs:";
const CLEANUP_RETRY_BASE_MS = 15_000;
const CLEANUP_RETRY_MAX_MS = 5 * 60_000;
const SANDBOX_DESTROY_TIMEOUT_MS = 15_000;

export class AgentRuntime extends DurableObject<Env> {
  private qualificationAuthority?: NativeBoundaryQualificationOwner;
  private readonly nativeCommands = new Map<string, OwnedNativeCommandSession>();
  private readonly workspaceRuntimes = new Map<string, WorkspaceRuntimeEntry>();
  private readonly workspaceRuntimePromises = new Map<string, Promise<WorkspaceRuntimeEntry>>();
  private stream = new StreamHandler();
  private storageService: StorageService;
  private readonly artifactBucket: ComposeRuntimeInput["r2Bucket"];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.artifactBucket = env.ARTIFACTS as unknown as ComposeRuntimeInput["r2Bucket"];
    this.storageService = new StorageService(env.ARTIFACTS);
  }

  private assertProductPlane(): void {
    if (isQualificationEnvironment(this.env)) throw new Error("QUALIFICATION_PLANE_ONLY");
  }
  private qualificationOwner(): NativeBoundaryQualificationOwner {
    if (!isQualificationEnvironment(this.env)) throw new Error("NATIVE_QUALIFICATION_UNAVAILABLE");
    return this.qualificationAuthority ??= new NativeBoundaryQualificationOwner(this.ctx, this.env);
  }
  async qualificationControl(auth: QualificationAuthorization, command: QualificationCommand): Promise<unknown> {
    return this.qualificationOwner().control(auth, command);
  }
  async qualificationAdmitRaw(auth: QualificationAuthorization, binding: ResourceSetupBinding, sandboxObjectId: string,
    action: QualificationRawAction): Promise<boolean> {
    return this.qualificationOwner().admitRaw(auth, binding, sandboxObjectId, action);
  }

  async qualificationContinueRaw(auth: QualificationAuthorization, binding: ResourceSetupBinding, sandboxObjectId: string,
    action: Exclude<QualificationRawAction, "retire">): Promise<boolean> {
    return this.qualificationOwner().continueRaw(auth, binding, sandboxObjectId, action);
  }

  async qualificationAuthorizeNamespaceControl(auth: QualificationAuthorization, binding: ResourceSetupBinding, nonce: string,
    token: string, identity: unknown, action: "status" | "start" | "stop" | "ack", sandboxObjectId: string): Promise<boolean> {
    return this.qualificationOwner().authorizeNamespaceControl(auth, binding, nonce, token, identity, action, sandboxObjectId);
  }

  private createPluginRegistry(): Map<string, IPlugin> {
    const plugins = [
      new PythonPlugin(),
      new RedisPlugin(),
      new FileSystemPlugin(),
      new GitPlugin(),
      new GitHubPlugin(),
      new GitHubCliPlugin(),
      new BashPlugin(),
      new NodePlugin(),
      new RustPlugin(),
    ];
    return new Map(plugins.map((plugin) => [plugin.name, plugin]));
  }

  private async ensureWorkspaceRuntime(
    lease: SandboxExecutionLease,
    initializePlugins: boolean,
  ): Promise<WorkspaceRuntimeEntry> {
    const original = await this.getExecutionSession(lease.owner);
    if (!original || !sameExecutionLease(original.lease, lease)) throw new Error("ORIGINAL_SESSION_UNAVAILABLE");
    const native = original.executionDomain?.domain === "legioncode_native";
    if (hasExecutionDomain(original) && !native) throw new Error("EXECUTION_DOMAIN_BINDING_UNAVAILABLE");
    const physical = native ? snapshotNativeSandboxPhysicalBinding(original.nativeSandboxBinding) : undefined;
    const workspaceKey = workspaceLeaseKey(lease);
    let entry = this.workspaceRuntimes.get(workspaceKey);
    if (!entry) {
      const pending = this.workspaceRuntimePromises.get(workspaceKey);
      if (pending) {
        entry = await pending;
      } else {
        const creation = this.composeWorkspaceRuntime(lease);
        this.workspaceRuntimePromises.set(workspaceKey, creation);
        try {
          entry = await creation;
          this.workspaceRuntimes.set(workspaceKey, entry);
        } finally {
          if (this.workspaceRuntimePromises.get(workspaceKey) === creation) {
            this.workspaceRuntimePromises.delete(workspaceKey);
          }
        }
      }
    }

    // Marked cache entries retain their exact original after shared awaits.
    // Unmarked legacy callers retain their existing multi-lease behavior.
    if (
      (entry.lease.executionDomainDigest !== undefined ||
        lease.executionDomainDigest !== undefined) &&
      !sameSandboxExecutionLease(entry.lease, lease)
    )
      throw new Error("EXECUTION_DOMAIN_BINDING_UNAVAILABLE");
    if (lease.executionDomainDigest !== undefined) {
      const original = await this.ctx.storage.get<PhysicalExecutionSessionRecord>(this.getExecutionSessionKey(lease.owner));
      if (!original || isQualificationRecord(original) || isRetiredExecutionSession(original) || original.cleanupInProgress || !this.matchesLease(original.lease, lease)) {
        await entry.composed.executionPort.cleanup(lease.leaseId);
        throw new Error("EXECUTION_DOMAIN_BINDING_UNAVAILABLE");
      }
    }
    if (JSON.stringify(entry.nativeSandboxBinding) !== JSON.stringify(physical)) throw new Error("NATIVE_SANDBOX_ORIGINAL_BINDING_UNAVAILABLE");
    entry.composed.executionPort.registerLease(lease);
    if (initializePlugins && !native) await this.ensurePluginsBooted(workspaceKey, entry);
    return entry;
  }

  private async composeWorkspaceRuntime(
    lease: SandboxExecutionLease,
  ): Promise<WorkspaceRuntimeEntry> {
    const original = await this.getExecutionSession(lease.owner);
    if (!original || !sameExecutionLease(original.lease, lease)) throw new Error("ORIGINAL_SESSION_UNAVAILABLE");
    if (hasExecutionDomain(original) && original.executionDomain?.domain !== "legioncode_native")
      throw new Error("EXECUTION_DOMAIN_BINDING_UNAVAILABLE");
    const nativeSandboxBinding = original.executionDomain?.domain === "legioncode_native"
      ? snapshotNativeSandboxPhysicalBinding(original.nativeSandboxBinding) : undefined;
    // SDK composition types its RPC stub as the concrete Sandbox class. This
    // transport-only adaptation follows exact resolver validation, not proof.
    const sandbox = nativeSandboxBinding
      ? await resolveNativeSandbox(this.env.NativeSandbox, lease, nativeSandboxBinding) as unknown as Sandbox
      : getSandbox(this.env.Sandbox, lease.sandboxId);
    const plugins = this.createPluginRegistry();
    const composed = composeRuntime({
      durableObjectState: this.ctx as unknown as LegacyDurableObjectState,
      sandbox,
      plugins,
      r2Bucket: this.artifactBucket,
      executionLease: lease,
    });
    return { composed, sandbox, plugins, lease, nativeSandboxBinding, pluginsBooted: false };
  }

  private async ensurePluginsBooted(
    workspaceKey: string,
    entry: WorkspaceRuntimeEntry,
  ): Promise<void> {
    if (entry.pluginsBooted) return;
    if (entry.pluginBootPromise) return await entry.pluginBootPromise;

    const boot = this.bootPlugins(entry.sandbox, entry.plugins).then(() => {
      entry.pluginsBooted = true;
    });
    entry.pluginBootPromise = boot;
    try {
      await boot;
    } finally {
      if (entry.pluginBootPromise === boot) {
        entry.pluginBootPromise = undefined;
      }
    }
  }

  private async bootPlugins(sandbox: Sandbox, plugins: Map<string, IPlugin>) {
    console.log("[AgentRuntime] Booting plugins for scoped sandbox lease...");

    const promises = Array.from(plugins.values()).map(async (plugin) => {
      if (plugin.setup) {
        await plugin.setup(sandbox);
      }
    });
    await Promise.all(promises);
    this.stream.broadcast("system", "Environment Optimized & Ready");
  }

  // 3. SRP: Pure Protocol Handling (WebSocket Upgrade)
  async fetch(request: Request) {
    this.assertProductPlane();
    const url = new URL(request.url);

    if (
      url.pathname === "/connect" &&
      request.headers.get("Upgrade") === "websocket"
    ) {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.stream.add(server as unknown as WebSocket);
      (server as unknown as WebSocket).accept();
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Not Found", { status: 404 });
  }

  async bootstrapNativeCheckout(sessionId: string, lease: SandboxExecutionLease, gitToken?: string) {
    this.assertProductPlane();
    const runtime = await this.ctx.blockConcurrencyWhile(async () => {
      const row = await this.ctx.storage.get<PhysicalExecutionSessionRecord>(this.getExecutionSessionKey(sessionId));
      if (!row || isQualificationRecord(row) || isRetiredExecutionSession(row) || row.cleanupInProgress ||
        !sameExecutionLease(row.lease, lease) || row.nativeCheckout?.phase !== "reserved" || hasUnsettledNativeCommand(row) ||
        (await validExecutionDomain(row))?.domain !== "legioncode_native") throw new Error("NATIVE_BOOTSTRAP_UNAVAILABLE");
      return this.ensureWorkspaceRuntime(lease, false);
    });
    const taskId = `bootstrap-${sessionId}`;
    const key = `${lease.leaseId}:${taskId}`;
    if (this.nativeCommands.has(key)) throw new Error("NATIVE_BOOTSTRAP_ALREADY_OWNED");
    const original = new OwnedNativeCommandSession({ state: this.ctx, sessionId, lease, taskId,
      sandbox: runtime.sandbox as unknown as OwnedNativeSandboxPort, artifacts: runtime.composed.artifactPort });
    this.nativeCommands.set(key, original);
    try {
      // This existing Git owner alone interprets its private credential. No
      // provider credential or arbitrary environment enters the bootstrap port.
      const git = runtime.plugins.get("git");
      if (!(git instanceof GitPlugin)) throw new Error("NATIVE_BOOTSTRAP_GIT_OWNER_REQUIRED");
      const receipt = await original.materializeCheckout(git.nativeBootstrapAuthEnvironment(gitToken));
      const settlement = original.bootstrapTransportSettlement();
      if (!settlement || settlement.receipt !== receipt) throw new Error("NATIVE_BOOTSTRAP_TRANSPORT_UNKNOWN");
      await original.produceNativeRuntimeObservation();
      await original.drainOriginalOperations();
      if (!await original.awaitClosure()) throw new Error("NATIVE_RUNTIME_CLOSURE_UNKNOWN");
      // inspect().image is only a provider START reference. The actual resource,
      // namespace and closure observations above cannot manufacture its missing
      // deployment/source association. Keep Ready blocked until that real owner
      // supplies verifiable evidence; never promote expected pins or labels.
      throw new Error("NATIVE_RUNTIME_DEPLOYMENT_BINDING_UNAVAILABLE");
    } catch (error) {
      if (error instanceof Error && error.message === "NATIVE_RUNTIME_DEPLOYMENT_BINDING_UNAVAILABLE") throw error;
      throw new Error("NATIVE_BOOTSTRAP_ORIGINAL_UNKNOWN");
    }
  }

  async authorizeNativeBootstrap(value: unknown, sandboxObjectId: string, intentValue: unknown): Promise<boolean> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const binding = NativeCommandBindingSchema.parse(value), key = this.getExecutionSessionKey(binding.sessionId);
      const row = await this.ctx.storage.get<PhysicalExecutionSessionRecord>(key);
      if (!row || isQualificationRecord(row) || isRetiredExecutionSession(row) || row.nativeCheckout?.rawStarted ||
        !await this.nativeBootstrapMatches(row, binding, sandboxObjectId, intentValue)) return false;
      await this.ctx.storage.put(key, { ...row, nativeCheckout: { ...row.nativeCheckout!, rawStarted: true } });
      return true;
    });
  }
  async continueNativeBootstrap(value: unknown, sandboxObjectId: string, intentValue: unknown, readOnly = false): Promise<{ expiresAt: number } | null> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const binding = NativeCommandBindingSchema.parse(value);
      const row = await this.ctx.storage.get<PhysicalExecutionSessionRecord>(this.getExecutionSessionKey(binding.sessionId));
      if (!row || isQualificationRecord(row) || isRetiredExecutionSession(row) || row.nativeCheckout?.rawStarted !== true ||
        !await this.nativeBootstrapMatches(row, binding, sandboxObjectId, intentValue, readOnly)) return null;
      return { expiresAt: Math.min(row.expiresAt, row.lease.expiresAt) };
    });
  }
  private async nativeBootstrapMatches(row: RuntimeSessionRecord, binding: Parameters<typeof sameNativeBinding>[0], sandboxObjectId: string, intentValue: unknown, readOnly = false) {
    const intent = NativeCheckoutBootstrapIntentSchema.parse(intentValue);
    if ((await validExecutionDomain(row))?.domain !== "legioncode_native") return false;
    const fresh = await this.ctx.storage.get<PhysicalExecutionSessionRecord>(this.getExecutionSessionKey(binding.sessionId));
    if (!fresh || JSON.stringify(fresh) !== JSON.stringify(row)) return false;
    const continuation = readOnly
      ? row.nativeCheckout?.phase === "materialized" && !!row.nativeCheckout.runtime &&
        sameNativeBinding(row.nativeCheckout.runtime.commandBinding, binding)
      : !!row.nativeCommand && sameNativeBinding(row.nativeCommand.binding, binding) &&
        (row.nativeCheckout?.phase === "dispatching" || (row.nativeCheckout?.phase === "materialized" && !row.nativeCheckout.runtime &&
          row.nativeCommand.kind === "command" && row.nativeCommand.request?.argv.length === 2 &&
          row.nativeCommand.request.argv[0] === "/usr/local/libexec/legioncode-command-supervisor" && row.nativeCommand.request.argv[1] === "--native-runtime-payload"));
    return JSON.stringify(row.nativeCheckout?.intent) === JSON.stringify(intent) && !row.cleanupInProgress && row.expiresAt > Date.now() && row.lease.expiresAt > Date.now() &&
      continuation && !!row.nativeCommand && !row.nativeCommand.stopRequested &&
      row.lease.owner === binding.sessionId && row.lease.leaseId === binding.leaseId && row.lease.sandboxId === binding.sandboxId &&
      row.lease.generation === binding.generation && row.lease.executionDomainDigest === binding.executionDomainDigest &&
      !!this.env.NativeSandbox && snapshotNativeSandboxPhysicalBinding(row.nativeSandboxBinding).sandboxObjectId === sandboxObjectId &&
      this.env.NativeSandbox.idFromName(binding.sandboxId).toString() === sandboxObjectId;
  }

  async getNativeCheckoutReadyEvidence(sessionId: string, lease: SandboxExecutionLease) {
    const row = await this.getExecutionSession(sessionId);
    if (!row || !sameExecutionLease(row.lease, lease) || row.cleanupInProgress ||
      row.nativeCheckout?.phase !== "materialized" || hasUnsettledNativeCommand(row) || row.expiresAt <= Date.now() ||
      row.lease.expiresAt <= Date.now() || (await validExecutionDomain(row))?.domain !== "legioncode_native") throw new Error("NATIVE_BOOTSTRAP_UNAVAILABLE");
    // Ready requires actual same-session image/resource/namespace evidence;
    // materialization or expected deployment pins alone cannot satisfy it.
    const evidence = parseNativeCheckoutReadyEvidence({ bootstrap: row.nativeCheckout.receipt,
      artifact: row.nativeCheckout.artifact, runtime: row.nativeCheckout.runtime });
    const binding = evidence.bootstrap.observation.binding;
    if (JSON.stringify(snapshotNativeSandboxPhysicalBinding(row.nativeSandboxBinding)) !== JSON.stringify(evidence.bootstrap.physicalBinding))
      throw new Error("NATIVE_SANDBOX_ORIGINAL_BINDING_UNAVAILABLE");
    const workspace = NativeWorkspaceStateSchema.parse(row.nativeWorkspace);
    if (workspace.root.device !== evidence.bootstrap.observation.root.device || workspace.root.inode !== evidence.bootstrap.observation.root.inode ||
      workspace.sandboxBootId !== evidence.bootstrap.observation.sandboxBootId || workspace.metadata.identity !== evidence.bootstrap.metadataIdentity ||
      workspace.metadata.paths.workspaceRoot !== lease.workspaceScope.root) throw new Error("NATIVE_BOOTSTRAP_WORKSPACE_MISMATCH");
    if (binding.sessionId !== sessionId || binding.leaseId !== lease.leaseId || binding.sandboxId !== lease.sandboxId ||
      binding.generation !== lease.generation || binding.executionDomainDigest !== lease.executionDomainDigest ||
      binding.workspaceId !== lease.workspaceScope.workspaceId || binding.runAttemptId !== lease.workspaceScope.runAttemptId ||
      binding.runId !== lease.workspaceScope.runId || binding.threadId !== lease.workspaceScope.threadId || binding.turnId !== lease.workspaceScope.turnId ||
      evidence.bootstrap.intent.root !== lease.workspaceScope.root) throw new Error("NATIVE_BOOTSTRAP_SCOPE_MISMATCH");
    const artifacts = new CloudflareArtifactStoreAdapter(this.env.ARTIFACTS as unknown as ConstructorParameters<typeof CloudflareArtifactStoreAdapter>[0]);
    const verifyArtifact = async (id: string, sha256: string, expected: unknown, size?: number) => {
      const metadata = await artifacts.getMetadata(id, sessionId);
      if (!metadata || metadata.size <= 0 || metadata.size > 128 * 1024 || (size !== undefined && metadata.size !== size))
        throw new Error("NATIVE_BOOTSTRAP_ARTIFACT_UNAVAILABLE");
      const bytes = await artifacts.download(id, sessionId);
      if (!bytes || bytes.byteLength !== metadata.size) throw new Error("NATIVE_BOOTSTRAP_ARTIFACT_UNAVAILABLE");
      const actual = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
      const canonical = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(canonical);
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)]));
        return value;
      };
      if (actual !== sha256 || JSON.stringify(canonical(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)))) !== JSON.stringify(canonical(expected)))
        throw new Error("NATIVE_BOOTSTRAP_ARTIFACT_MISMATCH");
    };
    await verifyArtifact(evidence.artifact.id, evidence.artifact.sha256, evidence.bootstrap, evidence.artifact.size);
    const { receiptArtifactId, receiptSha256, ...runtimeProof } = evidence.runtime;
    await verifyArtifact(receiptArtifactId, receiptSha256, runtimeProof);
    await verifyArtifact(evidence.runtime.resourceArtifactId, evidence.runtime.resourceSha256, row.nativeCheckout.runtimePreparation);
    await verifyArtifact(evidence.runtime.commandArtifactId, evidence.runtime.commandSha256, row.nativeCheckout.runtimeCommandReceipt);
    const runtime = this.workspaceRuntimes.get(workspaceLeaseKey(lease));
    const physical = runtime?.sandbox as unknown as OwnedNativeSandboxPort | undefined;
    if (!physical?.verifyNativeRuntimeOriginal) throw new Error("NATIVE_RUNTIME_ORIGINAL_UNAVAILABLE");
    await physical.verifyNativeRuntimeOriginal(evidence.runtime.commandBinding, row.nativeCheckout.runtimePreparation);
    // Artifact/physical I/O is not a lasting Ready grant. Recheck the same row
    // after it, with no lifecycle mutation or restart on this read-only path.
    const fresh = await this.getExecutionSession(sessionId);
    if (!fresh || JSON.stringify(fresh) !== JSON.stringify(row) || fresh.cleanupInProgress ||
      fresh.expiresAt <= Date.now() || fresh.lease.expiresAt <= Date.now()) throw new Error("NATIVE_RUNTIME_ORIGINAL_UNAVAILABLE");
    return evidence;
  }

  async executeTask(
    sessionId: string,
    input: TaskExecutionInput,
    hooks?: TaskExecutionHooks,
  ): Promise<TaskExecutionResult> {
    this.assertProductPlane();
    if (!input.lease) {
      return {
        taskId: input.taskId,
        leaseId: "",
        correlationId: "",
        status: "failure",
        retryable: false,
        error: {
          code: "LEASE_REQUIRED",
          message: "A scoped sandbox execution lease is required",
        },
      };
    }
    let nativeDomain = false;
    const runtime = await this.ctx.blockConcurrencyWhile(async () => {
      const persisted = await this.ctx.storage.get<PhysicalExecutionSessionRecord>(
        this.getExecutionSessionKey(sessionId),
      );
      if (
        !persisted ||
        isQualificationRecord(persisted) ||
        isRetiredExecutionSession(persisted) ||
        persisted.cleanupInProgress ||
        hasUnsettledNativeCommand(persisted) ||
        persisted.nativeCommand?.binding.taskId === input.taskId ||
        persisted.lease.owner !== sessionId ||
        !this.matchesLease(persisted.lease, input.lease)
      ) {
        return null;
      }
      const domain = await validExecutionDomain(persisted);
      if (hasExecutionDomain(persisted) && !domain) return null;
      nativeDomain = domain?.domain === "legioncode_native";
      if (nativeDomain) {
        try { await this.getNativeCheckoutReadyEvidence(sessionId, input.lease); }
        catch { return null; }
      }
      if (hasExecutionDomain(persisted) && !nativeDomain) return null;
      return await this.ensureWorkspaceRuntime(
        input.lease,
        !input.borrowedLease,
      );
    });
    if (!runtime) {
      return {
        taskId: input.taskId,
        leaseId: input.lease.leaseId,
        correlationId: input.lease.correlationId,
        status: "sandbox_unavailable",
        retryable: true,
        error: {
          code: "SANDBOX_CLEANUP_IN_PROGRESS",
          message: "The persisted sandbox lease is unavailable for execution",
        },
      };
    }
    const commandKey = `${input.lease.leaseId}:${input.taskId}`;
    if (nativeDomain && !input.borrowedLease && this.nativeCommands.has(commandKey)) {
      throw new Error("Native command execution already has an owner");
    }
    const nativeCommands = nativeDomain && !input.borrowedLease ? new OwnedNativeCommandSession({
      state: this.ctx, sessionId, lease: input.lease, taskId: input.taskId,
      sandbox: runtime.sandbox as unknown as OwnedNativeSandboxPort,
      artifacts: runtime.composed.artifactPort,
    }) : undefined;
    if (nativeCommands) this.nativeCommands.set(commandKey, nativeCommands);
    const expectedNativeScope = nativeCommands ? nativeCommandScope(sessionId, input.lease, input.taskId) : undefined;
    const result = await runtime.composed.executionPort.executeTask(
      input.lease.leaseId,
      { ...input, nativeCommands },
      hooks,
    );
    if (nativeCommands) {
      if (result.status === "cancelled" || result.status === "timeout") await nativeCommands.stop();
      await nativeCommands.drainOriginalOperations();
    }
    // Prefer the immutable exact-task result captured before the queue tail
    // released. A later task's current session slot cannot revise this proof.
    const nativeCommandClosure = nativeCommands && expectedNativeScope
      ? parseNativeCommandClosure(result.nativeCommandClosure ?? await nativeCommands.closureEvidence(), expectedNativeScope) ?? undefined
      : undefined;
    if (nativeCommands && (!await nativeCommands.awaitClosure() || nativeCommandClosure?.state !== "settled")) {
      await this.ctx.blockConcurrencyWhile(async () => {
        const key = this.getExecutionSessionKey(sessionId);
        const session = await this.ctx.storage.get<PhysicalExecutionSessionRecord>(key);
        if (session && !isQualificationRecord(session) && !isRetiredExecutionSession(session) && this.matchesLease(session.lease, input.lease)) {
          await this.markSandboxCleanupInProgress([[key, session]]);
          await this.persistSandboxCleanupRetry([[key, session]], Date.now(), "ORIGINAL_COMMAND_CLOSURE_UNKNOWN");
          await this.scheduleExecutionSessionAlarm();
        }
      });
      return { taskId: input.taskId, leaseId: input.lease.leaseId, correlationId: input.lease.correlationId,
        status: "sandbox_unavailable", retryable: false,
        ...(nativeCommandClosure ? { nativeCommandClosure } : {}),
        error: { code: "NATIVE_COMMAND_CLOSURE_UNKNOWN", message: "The original command remains owned; recovery must reconcile it without rerunning." } };
    }
    if (nativeCommands) this.nativeCommands.delete(commandKey);
    if (result.status === "sandbox_unavailable" && !input.borrowedLease) {
      await this.releaseLease(input.lease.leaseId);
    }
    return { ...result, ...(nativeCommandClosure ? { nativeCommandClosure } : {}) };
  }

  async getNativeCommandClosure(sessionId: string, lease: SandboxExecutionLease, taskId: string) {
    this.assertProductPlane();
    const session = await this.ctx.storage.get<PhysicalExecutionSessionRecord>(this.getExecutionSessionKey(sessionId));
    if (!session || isQualificationRecord(session) || isRetiredExecutionSession(session) || !this.matchesLease(session.lease, lease) || (await validExecutionDomain(session))?.domain !== "legioncode_native") return undefined;
    await resolveNativeSandbox(this.env.NativeSandbox, lease, session.nativeSandboxBinding);
    const runtime = this.workspaceRuntimes.get(workspaceLeaseKey(lease));
    const captured = await runtime?.composed.executionPort.getNativeCommandClosure?.(sessionId, lease, taskId);
    if (captured) return captured;
    return nativeClosureEvidence(sessionId, lease, taskId, session);
  }

  async cancelTask(leaseId: string, taskId: string): Promise<boolean> {
    this.assertProductPlane();
    const nativeCommands = this.nativeCommands.get(`${leaseId}:${taskId}`);
    if (nativeCommands && !await nativeCommands.stop()) return false;
    const owned = (await this.listExecutionSessions()).filter(
      ([, session]) => session.lease.leaseId === leaseId,
    );
    for (const [, session] of owned) {
      if (hasExecutionDomain(session)) {
        const domain = await validExecutionDomain(session);
        if (!domain) return false;
      }
    }
    for (const [workspaceKey, runtime] of this.workspaceRuntimes) {
      if (
        runtime.lease.leaseId === leaseId &&
        runtime.lease.executionDomainDigest !== undefined &&
        !owned.some(([, session]) =>
          this.matchesLease(session.lease, runtime.lease),
        )
      )
        return false;
      const cancelled = await runtime.composed.executionPort.cancelTask(
        leaseId,
        taskId,
      );
      if (cancelled) {
        return true;
      }
      if (workspaceKey.includes(leaseId)) {
        return false;
      }
    }
    return false;
  }

  async releaseLease(leaseId: string): Promise<void> {
    this.assertProductPlane();
    await this.ctx.blockConcurrencyWhile(() =>
      this.releaseLeaseInLock(leaseId),
    );
  }

  private async releaseLeaseInLock(leaseId: string): Promise<void> {
    const records = await this.listExecutionSessions();
    const owned = records.filter(
      ([, session]) => session.lease.leaseId === leaseId,
    );
    if (owned.length === 0) throw new Error("ORIGINAL_EXECUTION_SESSION_UNAVAILABLE");
    // Revoke bearer/capability before any awaited drain. Existing operations
    // may finish their original proof, but no fresh creator can use this row.
    await this.markSandboxCleanupInProgress(owned);
    if (owned.some(([, session]) => hasUnsettledNativeCommand(session))) {
      await this.scheduleExecutionSessionAlarm();
      throw new Error("Native command closure must settle before lease release");
    }

    const now = Date.now();
    const ownedIds = new Set(owned.map(([key]) => key));
    const sandboxIds = new Set(
      owned.map(([, session]) => session.lease.sandboxId),
    );
    for (const sandboxId of sandboxIds) {
      const group = records.filter(
        ([, session]) => session.lease.sandboxId === sandboxId,
      );
      if (group.some(([, session]) => hasExecutionDomain(session) && (session.executionDomain?.domain !== "legioncode_native" || !this.hasPositiveNativeClosure(session)))) {
        await this.markSandboxCleanupInProgress(group);
        await this.persistSandboxCleanupRetry(group, now);
        await this.scheduleExecutionSessionAlarm();
        throw new Error("MARKED_EXECUTION_CLEANUP_UNAVAILABLE");
      }
      const hasOtherLiveReference = group.some(
        ([key, session]) =>
          !ownedIds.has(key) &&
          (hasUnsettledNativeCommand(session) ||
            (!session.cleanupInProgress && session.lease.expiresAt > now)),
      );

      if (hasOtherLiveReference) {
        await this.releaseLoadedLease(leaseId);
        continue;
      }

      await this.markSandboxCleanupInProgress(group);
      try {
        await this.releaseLoadedLease(leaseId);
      } catch {
        await this.persistSandboxCleanupRetry(group, now);
        await this.scheduleExecutionSessionAlarm();
        throw new Error(
          "Sandbox lease release failed; cleanup will be retried",
        );
      }

      const cleaned = await this.cleanupSandbox(sandboxId, group, now);
      if (!cleaned) {
        await this.scheduleExecutionSessionAlarm();
        throw new Error("Sandbox cleanup failed; cleanup will be retried");
      }
    }
    await this.scheduleExecutionSessionAlarm();
  }

  async deleteExecutionSession(
    sessionId: string,
    expectedLease: SandboxExecutionLease,
  ): Promise<void> {
    this.assertProductPlane();
    await this.ctx.blockConcurrencyWhile(async () => {
      const key = this.getExecutionSessionKey(sessionId);
      const existing = await this.ctx.storage.get<PhysicalExecutionSessionRecord>(key);
      if (!existing || isQualificationRecord(existing) || isRetiredExecutionSession(existing) || !this.matchesLease(existing.lease, expectedLease)) {
        return;
      }

      await this.releaseLeaseInLock(expectedLease.leaseId);

      const current = await this.ctx.storage.get<PhysicalExecutionSessionRecord>(key);
      if (!current || isQualificationRecord(current) || isRetiredExecutionSession(current) || !this.matchesLease(current.lease, expectedLease)) {
        return;
      }
      if (current.cleanupInProgress) {
        throw new Error("Sandbox cleanup is pending for this session");
      }
      await this.retireExecutionSessionRecord(sessionId, current);
      await this.scheduleExecutionSessionAlarm();
    });
  }

  private matchesLease(actual: SandboxExecutionLease, expected: SandboxExecutionLease): boolean {
    return sameSandboxExecutionLease(actual, expected);
  }

  private async releaseLoadedLease(leaseId: string): Promise<void> {
    for (const [workspaceKey, runtime] of this.workspaceRuntimes) {
      const release = await runtime.composed.executionPort.releaseLease(
        leaseId,
        {
          destroySandbox: false,
        },
      );
      if (release.sandboxReleased) {
        this.workspaceRuntimes.delete(workspaceKey);
      }
      if (release.released) return;
    }
  }

  getManifest() {
    this.assertProductPlane();
    return Array.from(this.createPluginRegistry().values()).flatMap(
      (plugin) => plugin.tools,
    );
  }

  async storeExecutionSession(
    sessionId: string,
    session: RuntimeSessionRecord,
  ): Promise<void> {
    this.assertProductPlane();
    const incomingDomain = session.executionDomain ? snapshotExecutionDomain(session.executionDomain) : undefined;
    const incomingPhysical = session.nativeSandboxBinding ? snapshotNativeSandboxPhysicalBinding(session.nativeSandboxBinding) : undefined;
    session = { ...session, ...(incomingPhysical ? { nativeSandboxBinding: incomingPhysical } : {}), workspaceScope: Object.freeze({ ...session.workspaceScope }),
      lease: Object.freeze({ ...session.lease, workspaceScope: Object.freeze({ ...session.lease.workspaceScope }) }),
      ...(incomingDomain ? { executionDomain: incomingDomain } : {}) };
    if (incomingDomain && (session.lease.owner !== sessionId || session.runId !== incomingDomain.scope.runId))
      throw new Error("EXECUTION_DOMAIN_BINDING_UNAVAILABLE");
    await this.ctx.blockConcurrencyWhile(async () => {
      const bindings = await this.ctx.storage.list<PhysicalExecutionSessionRecord>({ prefix: EXECUTION_SESSION_KEY_PREFIX });
      if ([...bindings.values()].some(isQualificationRecord)) throw new Error("QUALIFICATION_PLANE_ONLY");
      await assertExecutionDomainAdmission(
        [...bindings].filter((entry): entry is [string, RuntimeSessionRecord | RetiredExecutionSessionRecord] => !isQualificationRecord(entry[1])),
        this.getExecutionSessionKey(sessionId), session,
      );
      const sessions = await this.listExecutionSessions();
      const sessionKey = this.getExecutionSessionKey(sessionId);
      if (
        sessions.some(
          ([key, existing]) =>
            (existing.cleanupInProgress || hasUnsettledNativeCommand(existing)) &&
            (key === sessionKey ||
              existing.lease.sandboxId === session.lease.sandboxId),
        )
      ) {
        throw new Error("Sandbox cleanup is in progress for this lease");
      }
      const existing = sessions.find(([key]) => key === sessionKey)?.[1];
      // Session API updates cannot supply or transplant physical command proof.
      const { nativeWorkspace: _workspace, nativeCommand: _command, nativeCheckout: _checkout,
        nativeCheckoutIntent: requestedIntent, nativeSandboxBinding: suppliedPhysical, ...incoming } = session;
      const nativeDomain = incomingDomain?.domain === "legioncode_native";
      const nativeSandboxBinding = nativeDomain
        ? existing ? snapshotNativeSandboxPhysicalBinding(existing.nativeSandboxBinding)
          : await selectNativeSandboxBinding(this.env.NativeSandbox, session.lease)
        : undefined;
      if (suppliedPhysical && JSON.stringify(snapshotNativeSandboxPhysicalBinding(suppliedPhysical)) !== JSON.stringify(nativeSandboxBinding))
        throw new Error("NATIVE_SANDBOX_ORIGINAL_BINDING_UNAVAILABLE");
      if (nativeDomain && (!this.env.NativeSandbox || this.env.NativeSandbox.idFromName(session.lease.sandboxId).toString() !== nativeSandboxBinding?.sandboxObjectId))
        throw new Error("NATIVE_SANDBOX_ORIGINAL_BINDING_UNAVAILABLE");
      const intent = requestedIntent ? freezeBootstrap(NativeCheckoutBootstrapIntentSchema.parse(requestedIntent)) : undefined;
      if (intent && (incomingDomain?.domain !== "legioncode_native" || intent.root !== session.workspaceScope.root)) throw new Error("NATIVE_BOOTSTRAP_SCOPE_MISMATCH");
      if (existing && intent && JSON.stringify(existing.nativeCheckout?.intent) !== JSON.stringify(intent)) throw new Error("NATIVE_BOOTSTRAP_INTENT_IMMUTABLE");
      const native = existing && this.matchesLease(existing.lease, session.lease)
        ? { nativeWorkspace: existing.nativeWorkspace, nativeCommand: existing.nativeCommand, nativeCheckout: existing.nativeCheckout }
        : intent ? { nativeCheckout: { intent, phase: "reserved" as const } } : {};
      await this.ctx.storage.put(
        this.getExecutionSessionKey(sessionId),
        { ...incoming, ...native, ...(nativeSandboxBinding ? { nativeSandboxBinding } : {}) },
      );
      await this.scheduleExecutionSessionAlarm();
    });
  }

  async alarm(): Promise<void> {
    if (isQualificationEnvironment(this.env)) return; // No qualification wake/start/recreate path.
    await this.ctx.blockConcurrencyWhile(async () => {
      const records = await this.listExecutionSessions();
      const now = Date.now();
      const bySandbox = new Map<
        string,
        Array<[string, RuntimeSessionRecord]>
      >();
      for (const entry of records) {
        const group = bySandbox.get(entry[1].lease.sandboxId) ?? [];
        group.push(entry);
        bySandbox.set(entry[1].lease.sandboxId, group);
      }

      for (const [sandboxId, group] of bySandbox) {
        const cleanupCandidates = group.filter(
          ([, session]) =>
            session.cleanupInProgress || session.lease.expiresAt <= now,
        );
        const due = cleanupCandidates.filter(
          ([, session]) =>
            session.cleanupRetryAt === undefined ||
            session.cleanupRetryAt <= now,
        );
        if (due.length === 0) continue;

        const hasLiveReference = group.some(
          ([, session]) =>
            !session.cleanupInProgress && session.lease.expiresAt > now,
        );
        if (hasLiveReference) continue;

        await this.markSandboxCleanupInProgress(cleanupCandidates);
        if (group.some(([, session]) => hasUnsettledNativeCommand(session))) continue;
        await this.cleanupSandbox(sandboxId, cleanupCandidates, now);
        // A Durable Object alarm has a bounded callback lifetime. Keep each
        // callback to one physical destroy; scheduling below immediately
        // continues with any other eligible sandbox groups.
        break;
      }

      await this.scheduleExecutionSessionAlarm();
    });
  }

  async getExecutionSession(
    sessionId: string,
  ): Promise<RuntimeSessionRecord | null> {
    this.assertProductPlane();
    const session = await this.ctx.storage.get<PhysicalExecutionSessionRecord>(
      this.getExecutionSessionKey(sessionId),
    );
    if (!session || isQualificationRecord(session) || isRetiredExecutionSession(session) || session.cleanupInProgress) return null;
    const domain = await validExecutionDomain(session);
    if ((session.executionDomain || session.lease.executionDomainDigest) && !domain) return null;
    if (domain?.domain === "legioncode_native") await resolveNativeSandbox(this.env.NativeSandbox, session.lease, session.nativeSandboxBinding);
    else if (session.nativeSandboxBinding) throw new Error("NATIVE_SANDBOX_ORIGINAL_BINDING_UNAVAILABLE");
    return session;
  }

  async appendExecutionLog(
    sessionId: string,
    entry: RuntimeSessionLogEntry,
  ): Promise<void> {
    this.assertProductPlane();
    await this.ctx.blockConcurrencyWhile(async () => {
      const key = this.getExecutionLogKey(sessionId, entry.timestamp);
      await this.ctx.storage.put(key, entry);
    });
  }

  async getExecutionLogs(
    sessionId: string,
    since?: number,
    taskId?: string,
  ): Promise<RuntimeSessionLogEntry[]> {
    this.assertProductPlane();
    const list = await this.ctx.storage.list<RuntimeSessionLogEntry>({
      prefix: this.getExecutionLogPrefix(sessionId),
    });
    const entries = Array.from(list.values()).sort(
      (left, right) => left.timestamp - right.timestamp,
    );
    return entries.filter((entry) => {
      const matchesSince = since === undefined || entry.timestamp > since;
      const matchesTask = taskId === undefined || entry.taskId === taskId;
      return matchesSince && matchesTask;
    });
  }

  private async listExecutionSessions(): Promise<
    Array<[string, RuntimeSessionRecord]>
  > {
    const sessions = await this.ctx.storage.list<PhysicalExecutionSessionRecord>({
      prefix: EXECUTION_SESSION_KEY_PREFIX,
    });
    if ([...sessions.values()].some(isQualificationRecord)) throw new Error("QUALIFICATION_PLANE_ONLY");
    return Array.from(sessions.entries()).filter((entry): entry is [string, RuntimeSessionRecord] => !isQualificationRecord(entry[1]) && !isRetiredExecutionSession(entry[1]));
  }

  private async scheduleExecutionSessionAlarm(): Promise<void> {
    const sessions = await this.listExecutionSessions();
    if (sessions.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const now = Date.now();
    let nextAlarm = Number.POSITIVE_INFINITY;
    const bySandbox = new Map<string, RuntimeSessionRecord[]>();
    for (const [, session] of sessions) {
      const group = bySandbox.get(session.lease.sandboxId) ?? [];
      group.push(session);
      bySandbox.set(session.lease.sandboxId, group);
    }

    for (const group of bySandbox.values()) {
      if (group.some(hasUnsettledNativeCommand)) {
        nextAlarm = Math.min(nextAlarm, now + CLEANUP_RETRY_BASE_MS);
        continue;
      }
      const liveExpirations = group
        .filter(
          (session) =>
            !session.cleanupInProgress && session.lease.expiresAt > now,
        )
        .map((session) => session.lease.expiresAt);
      if (liveExpirations.length > 0) {
        // Protected cleanup waits until the earliest live reference can be
        // reconsidered, without retrying every millisecond while it remains.
        const earliestLiveExpiry = liveExpirations.reduce(
          (earliest, expiresAt) => Math.min(earliest, expiresAt),
          Number.POSITIVE_INFINITY,
        );
        nextAlarm = Math.min(nextAlarm, earliestLiveExpiry);
        continue;
      }

      const cleanupCandidates = group.filter(
        (session) =>
          session.cleanupInProgress || session.lease.expiresAt <= now,
      );
      if (cleanupCandidates.length > 0) {
        const nextAttempt = cleanupCandidates.reduce(
          (earliest, session) =>
            Math.min(earliest, session.cleanupRetryAt ?? now),
          Number.POSITIVE_INFINITY,
        );
        nextAlarm = Math.min(nextAlarm, Math.max(nextAttempt, now + 1));
        continue;
      }

      const earliestExpiry = group.reduce(
        (earliest, session) => Math.min(earliest, session.lease.expiresAt),
        Number.POSITIVE_INFINITY,
      );
      nextAlarm = Math.min(nextAlarm, earliestExpiry);
    }
    await this.ctx.storage.setAlarm(nextAlarm);
  }

  private async markSandboxCleanupInProgress(
    group: Array<[string, RuntimeSessionRecord]>,
  ): Promise<void> {
    // Invoke existing marked fences synchronously before the first closing
    // await. Cancellation observers never become release/closure evidence.
    const fences = group.filter(([, session]) => hasExecutionDomain(session)).flatMap(([, session]) =>
      [...this.workspaceRuntimes.values()].map(runtime => runtime.composed.executionPort.cleanup(session.lease.leaseId)));
    const fenced = Promise.allSettled(fences);
    for (const [key] of group) {
      const session = await this.ctx.storage.get<PhysicalExecutionSessionRecord>(key);
      if (!session || isQualificationRecord(session) || isRetiredExecutionSession(session)) continue;
      await this.ctx.storage.put(key, { ...session, token: "", cleanupInProgress: true });
    }
    if ((await fenced).some(result => result.status === "rejected")) throw new Error("MARKED_EXECUTION_CLEANUP_UNAVAILABLE");
  }

  private async persistSandboxCleanupRetry(
    group: Array<[string, RuntimeSessionRecord]>,
    now: number,
    code: RuntimeSessionRecord["cleanupFailureCode"] = "SANDBOX_CLEANUP_FAILED",
  ): Promise<void> {
    for (const [key] of group) {
      const session = await this.ctx.storage.get<PhysicalExecutionSessionRecord>(key);
      if (!session || isQualificationRecord(session) || isRetiredExecutionSession(session)) continue;
      const attempts = (session.cleanupAttempts ?? 0) + 1;
      const delay = Math.min(
        CLEANUP_RETRY_BASE_MS * 2 ** (attempts - 1),
        CLEANUP_RETRY_MAX_MS,
      );
      await this.ctx.storage.put(key, {
        ...session,
        cleanupInProgress: true,
        cleanupAttempts: attempts,
        cleanupFailureCode: code,
        cleanupRetryAt: now + delay,
      });
    }
  }

  private async cleanupSandbox(
    sandboxId: string,
    group: Array<[string, RuntimeSessionRecord]>,
    now: number,
  ): Promise<boolean> {
    try {
      if (group.some(([, session]) => hasExecutionDomain(session) && session.executionDomain?.domain !== "legioncode_native")) {
        await this.markSandboxCleanupInProgress(group);
        throw new Error("MARKED_EXECUTION_CLEANUP_UNAVAILABLE");
      }
      for (const [, session] of group) {
        const domain = await validExecutionDomain(session);
        if ((session.executionDomain || session.lease.executionDomainDigest) && !domain) throw new Error("EXECUTION_DOMAIN_BINDING_UNAVAILABLE");
        if (session.nativeSandboxBinding && domain?.domain !== "legioncode_native") throw new Error("NATIVE_SANDBOX_ORIGINAL_BINDING_UNAVAILABLE");
      }
      // Resolve only the stored original class/namespace for Native cleanup.
      const original = group[0]?.[1];
      if (!original) throw new Error("ORIGINAL_SESSION_UNAVAILABLE");
      const native = original.executionDomain?.domain === "legioncode_native";
      if (group.some(([, session]) => (session.executionDomain?.domain === "legioncode_native") !== native ||
        (native && JSON.stringify(session.nativeSandboxBinding) !== JSON.stringify(original.nativeSandboxBinding))))
        throw new Error("NATIVE_SANDBOX_ORIGINAL_BINDING_UNAVAILABLE");
      const sandbox = native ? await resolveNativeSandbox(this.env.NativeSandbox, original.lease, original.nativeSandboxBinding) as unknown as Sandbox
        : getSandbox(this.env.Sandbox, sandboxId);
      for (const [, session] of group) {
        if (session.executionDomain?.domain === "legioncode_native" && !this.hasPositiveNativeClosure(session)) throw new Error("Original physical closure remains unknown");
        await this.releaseLoadedLease(session.lease.leaseId);
      }
      await destroySandboxWithTimeout(sandbox, SANDBOX_DESTROY_TIMEOUT_MS);
      for (const [, session] of group) {
        this.workspaceRuntimes.delete(workspaceLeaseKey(session.lease));
      }
      for (const [key, session] of group) {
        const sessionId = key.slice(EXECUTION_SESSION_KEY_PREFIX.length);
        await this.retireExecutionSessionRecord(sessionId, session);
      }
      return true;
    } catch {
      await this.persistSandboxCleanupRetry(group, now);
      return false;
    }
  }

  private hasPositiveNativeClosure(session: RuntimeSessionRecord): boolean {
    const taskId = session.nativeCommand?.binding.taskId;
    return !!taskId && nativeClosureEvidence(session.lease.owner, session.lease, taskId, session)?.state === "settled";
  }

  private async retireExecutionSessionRecord(sessionId: string, session: RuntimeSessionRecord): Promise<void> {
    if (hasExecutionDomain(session) && (session.executionDomain?.domain !== "legioncode_native" || !this.hasPositiveNativeClosure(session)))
      throw new Error("MARKED_EXECUTION_CLEANUP_UNAVAILABLE");
    // Same original row is permanent deny/reconciliation history; no TTL or sweep.
    // Only actual physical destruction plus retained original transport settlement
    // reaches this caller. Unknown rows remain closing and count as active.
    await this.ctx.storage.put(this.getExecutionSessionKey(sessionId), retiredExecutionBinding(session));
    const logs = await this.ctx.storage.list({
      prefix: this.getExecutionLogPrefix(sessionId),
    });
    const logKeys = Array.from(logs.keys());
    const keysToDelete = logKeys;
    for (let i = 0; i < keysToDelete.length; i += 128) {
      await this.ctx.storage.delete(keysToDelete.slice(i, i + 128));
    }
  }

  private getExecutionSessionKey(sessionId: string): string {
    return `${EXECUTION_SESSION_KEY_PREFIX}${sessionId}`;
  }

  private getExecutionLogPrefix(sessionId: string): string {
    return `${EXECUTION_LOG_KEY_PREFIX}${sessionId}:`;
  }

  private getExecutionLogKey(sessionId: string, timestamp: number): string {
    const paddedTimestamp = timestamp.toString().padStart(15, "0");
    const suffix = Math.random().toString(36).slice(2, 8);
    return `${this.getExecutionLogPrefix(sessionId)}${paddedTimestamp}-${suffix}`;
  }

  // 5. SRP: History Management
  async getHistory(
    runId: string,
    cursor?: string,
    limit: number = 50,
  ): Promise<{ messages: Message[]; nextCursor?: string }> {
    this.assertProductPlane();
    const listOptions: { prefix: string; limit: number; start?: string } = {
      prefix: `chat:${runId}:`,
      limit: limit + 1,
    };

    if (cursor) {
      listOptions.start = cursor;
    }

    const list = await this.ctx.storage.list<Message>(listOptions);
    const entries = Array.from(list.entries());

    let nextCursor: string | undefined;
    if (entries.length > limit) {
      const lastEntry = entries.pop();
      if (lastEntry) {
        nextCursor = lastEntry[0];
      }
    }

    // Ensure all messages have unique IDs for React rendering
    const messages = entries.map(([_, msg], index) => ({
      ...msg,
      id: msg.id || `${runId}-${index}-${Date.now()}`,
    }));

    return { messages, nextCursor };
  }

  async appendMessage(
    runId: string,
    message: Message,
    idempotencyKey?: string,
  ): Promise<void> {
    this.assertProductPlane();
    await this.ctx.blockConcurrencyWhile(async () => {
      const sessionId = this.ctx.id.toString();

      // Check idempotency
      if (idempotencyKey) {
        const existingKey = `idempotency:${runId}:${idempotencyKey}`;
        const exists = await this.ctx.storage.get<string>(existingKey);
        if (exists) {
          console.log(
            `[AgentRuntime] Duplicate message ignored for idempotency key: ${idempotencyKey}`,
          );
          return;
        }
      }

      // Ensure message has an ID
      const messageWithId: Message = {
        role: message.role,
        content: message.content,
        tool_calls: message.tool_calls,
        tool_call_id: message.tool_call_id,
        id:
          message.id ||
          `${runId}-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
      };

      const processedMessage = await this.storageService.processMessage(
        runId,
        sessionId,
        messageWithId,
      );

      const existing = await this.ctx.storage.list<Message>({
        prefix: `chat:${runId}:`,
        reverse: true,
        limit: 1,
      });

      const lastEntry = Array.from(existing.entries())[0];
      const isPartial =
        message.role === "assistant" &&
        typeof message.content === "string" &&
        message.content.includes("▌");

      if (lastEntry && isPartial) {
        const [lastKey, lastMsg] = lastEntry;
        if (
          lastMsg.role === "assistant" &&
          typeof lastMsg.content === "string" &&
          lastMsg.content.includes("▌")
        ) {
          await this.ctx.storage.put(lastKey, processedMessage);
          return;
        }
      }

      const timestamp = Date.now().toString().padStart(15, "0");
      const disambiguator = Math.random().toString(36).substring(2, 7);
      const key = `chat:${runId}:${timestamp}-${disambiguator}`;
      await this.ctx.storage.put(key, processedMessage);

      // Store idempotency key
      if (idempotencyKey) {
        const existingKey = `idempotency:${runId}:${idempotencyKey}`;
        await this.ctx.storage.put(existingKey, key);
      }
    });
  }

  async saveHistory(
    runId: string,
    messages: Message[],
    idempotencyKey?: string,
  ): Promise<void> {
    this.assertProductPlane();
    await this.ctx.blockConcurrencyWhile(async () => {
      const sessionId = this.ctx.id.toString();

      // Check idempotency
      if (idempotencyKey) {
        const existingKey = `idempotency:${runId}:batch:${idempotencyKey}`;
        const exists = await this.ctx.storage.get<string>(existingKey);
        if (exists) {
          console.log(
            `[AgentRuntime] Duplicate batch ignored for idempotency key: ${idempotencyKey}`,
          );
          return;
        }
      }

      const existing = await this.ctx.storage.list({
        prefix: `chat:${runId}:`,
      });
      const chatKeys = Array.from(existing.keys());

      const idempotency = await this.ctx.storage.list({
        prefix: `idempotency:${runId}:`,
      });
      const idempotencyKeys = Array.from(idempotency.keys());

      const allKeysToDelete = [...chatKeys, ...idempotencyKeys];
      if (allKeysToDelete.length > 0) {
        // Durable Object storage.delete() has a limit of 128 keys per call
        for (let i = 0; i < allKeysToDelete.length; i += 128) {
          const chunk = allKeysToDelete.slice(i, i + 128);
          await this.ctx.storage.delete(chunk);
        }
      }

      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg) continue;

        // Ensure message has an ID
        const msgWithId: Message = {
          role: msg.role,
          content: msg.content,
          tool_calls: msg.tool_calls,
          tool_call_id: msg.tool_call_id,
          id: msg.id || `${runId}-msg-${i}-${Date.now()}`,
        };
        const processedMessage = await this.storageService.processMessage(
          runId,
          sessionId,
          msgWithId,
        );
        const timestamp = Date.now().toString().padStart(15, "0");
        const key = `chat:${runId}:${timestamp}-${i.toString().padStart(3, "0")}`;
        await this.ctx.storage.put(key, processedMessage);
      }

      // Store idempotency key
      if (idempotencyKey) {
        const existingKey = `idempotency:${runId}:batch:${idempotencyKey}`;
        await this.ctx.storage.put(existingKey, "saved");
      }
    });

  }
}

async function destroySandboxWithTimeout(
  sandbox: Sandbox,
  timeoutMs: number,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      sandbox.destroy(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Sandbox cleanup timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
