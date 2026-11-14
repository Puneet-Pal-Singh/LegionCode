import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fstatSync, lstatSync, realpathSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { NativeGitMetadataLayout } from "./NativeFilesystemBridge.js";
import type { LocalTurnAttemptIdentity } from "./LocalReadOnlyTurnExecutor.js";
import type { LocalProcessOutput } from "./NativeProcessOutput.js";
import {
  MAC_HOST_BROKER_ABI, MAC_HOST_MAX_FRAME, MacHostBrokerError,
  decodeMacHostFrame, encodeMacHostFrame, macHostCommandDigest,
  macHostDigest, macHostNumber, macHostScopeDigest, macHostText, macHostMetadataFields, macHostMetadataDigest,
  type MacHostFields,
} from "./MacHostBrokerProtocol.js";

type Reply = ReadonlyMap<string, Buffer>;
type Identity = Readonly<{ rootDevice: bigint; rootInode: bigint; namespaceDevice: bigint; namespaceInode: bigint; fenceDevice: bigint; fenceInode: bigint }>;
export type MacHostRecoveryResource = Readonly<{ resourceId: string; resourceGeneration: string }>;
export type MacHostRecoveryScope = Readonly<{ attempt: LocalTurnAttemptIdentity; identity: Identity }>;
const cleanupReceiptBrand: unique symbol = Symbol("MacHostInterruptedCleanupReceipt");
type RecoveryIdentity = Identity & MacHostRecoveryResource & Readonly<{
  scopeSHA256: string; bindingSHA256: string; capabilitySHA256: string; metadataSHA256: string;
  originGeneration: string; originBoot: string; policySHA256: string; policyGeneration: string;
}>;
/** Cleanup receipt only. It never fulfills an original bridge/resource promise,
 * reconstructs tool output, or proves canonical Turn/operation settlement. */
export type MacHostInterruptedCleanupReceipt = RecoveryIdentity & Readonly<{
  kind: "interrupted_cleanup"; cleanupBasis: "live_original_resources"; receiptId: string;
  [cleanupReceiptBrand]: true;
}>;
export type MacHostRecoveryObservation = MacHostInterruptedCleanupReceipt |
  (RecoveryIdentity & Readonly<{ kind: "cleanup_pending" | "cleanup_unknown" }>);
export interface MacHostBrokerOptions {
  readonly bridgePath: string;
  /** Protected setup receipt supplied by the trusted host, never a renderer field. */
  readonly serviceCodeRequirement: string;
  readonly expectedPolicySHA256: string;
  readonly expectedPolicyGeneration: string;
}
export interface MacHostCommandResource {
  readonly closed: Promise<void>;
  readonly quiescent: boolean;
  readonly closure: Readonly<{ kind: "not_prepared" } | ({ kind: "broker_closed"; generation: string; policySHA256: string;
    scopeSHA256: string; capability: string; resourceId: string; resourceGeneration: string; policyGeneration: string } & Identity)> | null;
  seal(): Promise<void>;
}

/** Original bridge lifetime. Requests are serialized and every original reply is
 * consumed. No reconnect/retry can create another command or prepared scope. */
class Bridge {
  readonly process: ChildProcessWithoutNullStreams;
  readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private pending: { resolve: (reply: Reply) => void; reject: (error: unknown) => void } | null = null;
  private bytes = Buffer.alloc(0);
  private tail: Promise<unknown> = Promise.resolve();
  private failure: MacHostBrokerError | null = null;
  private ended = false;
  constructor(options: MacHostBrokerOptions, root?: FileHandle, fence?: FileHandle, namespace?: FileHandle) {
    const stdio: Array<"pipe" | "ignore" | number> = ["pipe", "pipe", "pipe", "ignore", "ignore"];
    if (root && fence && namespace) stdio.push(root.fd, fence.fd, namespace.fd);
    this.process = spawn(options.bridgePath, ["--bridge", options.serviceCodeRequirement], {
      stdio, env: {}, shell: false, windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    this.closed = new Promise((resolve) => this.process.once("close", (code, signal) => {
      if (this.pending || !this.ended || code !== 0 || signal !== null) this.fail("bridge_closed");
      resolve({ code, signal });
    }));
    this.process.on("error", () => this.fail("bridge_unavailable"));
    this.process.stdin.on("error", () => this.fail("bridge_write_failed"));
    this.process.stdout.on("error", () => this.fail("bridge_read_failed"));
    this.process.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    let diagnostics = 0;
    this.process.stderr.on("data", (chunk: Buffer) => {
      diagnostics += chunk.length;
      if (diagnostics > 1024) this.fail("bridge_diagnostics_exceeded");
    });
    this.process.stderr.on("error", () => this.fail("bridge_read_failed"));
  }
  request(fields: MacHostFields): Promise<Reply> {
    const frame = encodeMacHostFrame(fields);
    const operation = this.tail.then(() => {
      if (this.failure || this.ended) throw this.failure ?? new MacHostBrokerError("bridge_closed", true);
      return new Promise<Reply>((resolve, reject) => {
        this.pending = { resolve, reject };
        this.process.stdin.write(frame, (error) => { if (error) this.fail("bridge_write_failed"); });
      });
    });
    this.tail = operation.catch(() => undefined); return operation;
  }
  async end(): Promise<void> {
    await this.tail;
    this.ended = true; this.process.stdin.end();
    const result = await this.closed;
    if (this.failure || result.code !== 0 || result.signal !== null || this.bytes.length) {
      throw this.failure ?? new MacHostBrokerError("bridge_closure_unconfirmed", true);
    }
  }
  private receive(chunk: Buffer): void {
    try {
      if (chunk.length + this.bytes.length > MAC_HOST_MAX_FRAME * 2 + 8) throw new Error();
      this.bytes = Buffer.concat([this.bytes, chunk]);
      while (this.bytes.length >= 4) {
        const size = this.bytes.readUInt32BE(0);
        if (!size || size > MAC_HOST_MAX_FRAME) throw new Error();
        if (this.bytes.length < size + 4) return;
        if (!this.pending) throw new Error();
        const reply = decodeMacHostFrame(this.bytes.subarray(4, size + 4));
        this.bytes = this.bytes.subarray(size + 4);
        const pending = this.pending; this.pending = null; pending.resolve(reply);
      }
    } catch { this.fail("invalid_bridge_frame"); }
  }
  private fail(reason: string): void {
    this.failure ??= new MacHostBrokerError(reason, true);
    const pending = this.pending; this.pending = null; pending?.reject(this.failure);
    /* Keep original streams/handles alive. A transport error never kills the
     * UID scope, unlocks the writer, or proves any resource closed. */
  }
}

function validateOptions(options: MacHostBrokerOptions): MacHostBrokerOptions {
  if (process.platform !== "darwin" || !isAbsolute(options.bridgePath) ||
      realpathSync(options.bridgePath) !== options.bridgePath || !options.serviceCodeRequirement ||
      options.serviceCodeRequirement.length > 4096 || options.serviceCodeRequirement.includes("\0") ||
      !/^[a-f0-9]{64}$/u.test(options.expectedPolicySHA256) || !/^[a-f0-9]{64}$/u.test(options.expectedPolicyGeneration)) throw new MacHostBrokerError("host_setup_required", false);
  const file = lstatSync(options.bridgePath);
  if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o022) !== 0 || (file.mode & 0o111) === 0 ||
      (file.mode & 0o6000) !== 0 || (file.uid !== 0 && file.uid !== process.geteuid?.())) throw new MacHostBrokerError("untrusted_bridge", false);
  return Object.freeze({ ...options });
}
function base(operation: string, generation?: string): Record<string, string> {
  return { version: MAC_HOST_BROKER_ABI, operation, ...(generation ? { generation } : {}) };
}
function response(reply: Reply): string {
  if (macHostText(reply, "version", 8) !== MAC_HOST_BROKER_ABI) throw new MacHostBrokerError("broker_abi_changed", true);
  const code = macHostText(reply, "code", 128), state = macHostText(reply, "state", 40);
  if (code !== "okay") throw new MacHostBrokerError(code, state === "unknown");
  return state;
}

/** Obtained only from the actual authenticated installed service. This check is
 * observational: no account, UID, file ACL, workspace or command is created. */
export class MacHostBrokerClient {
  private constructor(private readonly options: MacHostBrokerOptions, readonly generation: string) {}
  static async connect(input: MacHostBrokerOptions): Promise<MacHostBrokerClient> {
    const options = validateOptions(input), bridge = new Bridge(options);
    try {
      const reply = await bridge.request(base("status"));
      if (response(reply) !== "ready" || macHostDigest(reply, "policy") !== options.expectedPolicySHA256 ||
          macHostDigest(reply, "policyGeneration") !== options.expectedPolicyGeneration) {
        throw new MacHostBrokerError("host_setup_required", false);
      }
      const generation = macHostDigest(reply, "generation");
      return new MacHostBrokerClient(options, generation);
    } finally { await bridge.end(); }
  }
  /** Fresh cleanup transport. No original promise or execution handle is reused. */
  describeRecovery(input: MacHostRecoveryScope & { resource?: MacHostRecoveryResource }): Promise<MacHostRecoveryObservation> {
    return this.recover("recoveryDescribe", input);
  }
  /** Irreversible cleanup only: the server cannot prepare/release a command. */
  sealRecovery(input: MacHostRecoveryScope & { resource: MacHostRecoveryResource }): Promise<MacHostRecoveryObservation> {
    return this.recover("recoverySeal", input);
  }
  private async recover(operation: "recoveryDescribe" | "recoverySeal",
    input: MacHostRecoveryScope & { resource?: MacHostRecoveryResource }): Promise<MacHostRecoveryObservation> {
    const attempt = Object.freeze({ ...input.attempt });
    const attemptKeys = ["workspaceId", "threadId", "runId", "turnId", "runAttemptId"] as const;
    const identityKeys = ["rootDevice", "rootInode", "namespaceDevice", "namespaceInode", "fenceDevice", "fenceInode"] as const;
    if (Object.keys(attempt).length !== attemptKeys.length || attemptKeys.some((key) =>
      typeof attempt[key] !== "string" || !/^[\x21-\x7e]{1,256}$/u.test(attempt[key])) ||
      Object.keys(input.identity).length !== identityKeys.length || identityKeys.some((key) =>
        typeof input.identity[key] !== "bigint" || input.identity[key] < 0n || input.identity[key] > 0xffffffffffffffffn)) {
      throw new MacHostBrokerError("invalid_recovery_identity", false);
    }
    const physical = Object.freeze({ ...input.identity });
    const scopeSHA256 = macHostScopeDigest(attempt);
    const resource = input.resource ? Object.freeze({ ...input.resource }) : undefined;
    if (resource && (!/^[a-f0-9]{64}$/u.test(resource.resourceId) || !/^[a-f0-9]{64}$/u.test(resource.resourceGeneration))) {
      throw new MacHostBrokerError("invalid_recovery_identity", false);
    }
    const bridge = new Bridge(this.options);
    try {
      const reply = await bridge.request({ ...base(operation, this.generation), ...attempt,
        ...Object.fromEntries(Object.entries(physical).map(([key, value]) => [key, value.toString()])),
        resourceId: resource?.resourceId ?? "", resourceGeneration: resource?.resourceGeneration ?? "" });
      const state = response(reply);
      const keys = ["version", "state", "code", "generation", "originGeneration", "originBoot", "cleanupBasis",
        "scopeSHA256", "resourceId", "resourceGeneration", "policy", "policyGeneration", "capabilitySHA256", "receiptId", "bindingSHA256", "metadataSHA256",
        "rootDevice", "rootInode", "namespaceDevice", "namespaceInode", "fenceDevice", "fenceInode"];
      if (reply.size !== keys.length || keys.some((key) => !reply.has(key)) ||
          !["cleanupClosed", "cleanupPending", "unknown"].includes(state) ||
          macHostDigest(reply, "generation") !== this.generation || macHostDigest(reply, "originGeneration") !== this.generation ||
          macHostDigest(reply, "scopeSHA256") !== scopeSHA256 ||
          macHostDigest(reply, "policy") !== this.options.expectedPolicySHA256 ||
          macHostDigest(reply, "policyGeneration") !== this.options.expectedPolicyGeneration ||
          Object.entries(physical).some(([key, value]) => macHostNumber(reply, key) !== value)) {
        throw new MacHostBrokerError("recovery_identity_changed", true);
      }
      const originBoot = macHostText(reply, "originBoot", 36);
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(originBoot)) throw new MacHostBrokerError("invalid_recovery_receipt", true);
      const identity: RecoveryIdentity = Object.freeze({ ...physical, scopeSHA256, originBoot,
        originGeneration: this.generation, policySHA256: this.options.expectedPolicySHA256,
        policyGeneration: this.options.expectedPolicyGeneration, resourceId: macHostDigest(reply, "resourceId"),
        resourceGeneration: macHostDigest(reply, "resourceGeneration"), bindingSHA256: macHostDigest(reply, "bindingSHA256"),
        capabilitySHA256: macHostDigest(reply, "capabilitySHA256"), metadataSHA256: macHostDigest(reply, "metadataSHA256") });
      if (resource && (identity.resourceId !== resource.resourceId || identity.resourceGeneration !== resource.resourceGeneration)) {
        throw new MacHostBrokerError("recovery_identity_changed", true);
      }
      const receiptId = macHostDigest(reply, "receiptId"), basis = macHostText(reply, "cleanupBasis", 32);
      if (state === "cleanupClosed") {
        if (basis !== "liveOriginalResources" || /^0+$/u.test(receiptId)) throw new MacHostBrokerError("invalid_recovery_receipt", true);
        return Object.freeze({ ...identity, kind: "interrupted_cleanup", cleanupBasis: "live_original_resources", receiptId, [cleanupReceiptBrand]: true as const });
      }
      if (basis !== "unconfirmed" || !/^0+$/u.test(receiptId)) throw new MacHostBrokerError("invalid_recovery_receipt", true);
      return Object.freeze({ ...identity, kind: state === "unknown" ? "cleanup_unknown" : "cleanup_pending" });
    } finally {
      /* Caller cannot consume the receipt until THIS transport really closes.
       * This does not manufacture closure of any lost original transport. */
      await bridge.end();
    }
  }
  /** Caller registers this resource with the original lease BEFORE execute(). */
  createAttempt(input: { attempt: LocalTurnAttemptIdentity; rootDirectory: FileHandle; writerLease: FileHandle; namespaceDirectory: FileHandle; metadataLayout: NativeGitMetadataLayout }): MacHostCommandAttempt {
    return new MacHostCommandAttempt(this.options, this.generation, input);
  }
}

export class MacHostCommandAttempt implements MacHostCommandResource {
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  private rejectClosed!: (error: unknown) => void;
  private readonly bridge: Bridge;
  private readonly identity: Identity;
  private readonly scopeSHA256: string;
  private readonly metadataFields: Readonly<Record<string, string>>;
  private readonly metadataSHA256: string;
  private capability: string | null = null;
  private resourceId: string | null = null;
  private resourceGeneration: string | null = null;
  private preparation: Promise<void> | null = null;
  private command: Promise<LocalProcessOutput> | null = null;
  private closing: Promise<void> | null = null;
  private mayHaveScope = false;
  private sealed = false;
  private unknown = false;
  private closedProof: MacHostCommandResource["closure"] = null;
  private physicallyClosed = false;
  constructor(private readonly options: MacHostBrokerOptions, private readonly generation: string,
    private readonly input: { attempt: LocalTurnAttemptIdentity; rootDirectory: FileHandle; writerLease: FileHandle; namespaceDirectory: FileHandle; metadataLayout: NativeGitMetadataLayout }) {
    const root = fstatSync(input.rootDirectory.fd, { bigint: true }), fence = fstatSync(input.writerLease.fd, { bigint: true });
    const namespace = fstatSync(input.namespaceDirectory.fd, { bigint: true });
    if (!root.isDirectory() || !fence.isFile() || !namespace.isDirectory()) throw new MacHostBrokerError("invalid_original_authority", false);
    this.identity = Object.freeze({ rootDevice: root.dev, rootInode: root.ino, namespaceDevice: namespace.dev,
      namespaceInode: namespace.ino, fenceDevice: fence.dev, fenceInode: fence.ino });
    this.scopeSHA256 = macHostScopeDigest(input.attempt);
    this.metadataFields = macHostMetadataFields(input.metadataLayout);
    this.metadataSHA256 = macHostMetadataDigest(this.metadataFields);
    this.closed = new Promise((resolve, reject) => { this.resolveClosed = resolve; this.rejectClosed = reject; });
    void this.closed.catch(() => undefined);
    this.bridge = new Bridge(options, input.rootDirectory, input.writerLease, input.namespaceDirectory);
  }
  get quiescent(): boolean { return this.physicallyClosed && !this.unknown; }
  get closure(): MacHostCommandResource["closure"] { return this.closedProof; }

  execute(commandId: string, command: string, cwd: string, metadataLayout: NativeGitMetadataLayout): Promise<LocalProcessOutput> {
    if (this.sealed || this.unknown || this.command) return Promise.reject(new MacHostBrokerError("command_owner_unavailable", this.unknown));
    if (!commandId || commandId.length > 256 || !command || Buffer.byteLength(command) > 500 ||
        Buffer.byteLength(cwd) > 500 || command.includes("\0") || cwd.includes("\0")) return Promise.reject(new MacHostBrokerError("invalid_command", false));
    const metadataFields = macHostMetadataFields(metadataLayout);
    if (macHostMetadataDigest(metadataFields) !== this.metadataSHA256) return Promise.reject(new MacHostBrokerError("metadata_layout_changed", true));
    const operation = (async () => {
      await this.prepare();
      if (this.sealed) throw new MacHostBrokerError("attempt_sealed", false);
      const digest = macHostCommandDigest(command, cwd);
      const prepared = await this.scoped("prepareCommand", { commandId, command, cwd, ...metadataFields });
      if (this.readScope(prepared) !== "prepared" || macHostText(prepared, "commandId", 256) !== commandId ||
          macHostDigest(prepared, "commandDigest") !== digest) throw new MacHostBrokerError("command_identity_changed", true);
      /* No automatic retry, including response loss at this exact start barrier. */
      this.readScope(await this.scoped("releaseCommand", { commandId, commandDigest: digest }));
      for (;;) {
        const reply = await this.scoped("scopeStatus"), state = this.readScope(reply);
        if (state === "unknown") throw new MacHostBrokerError("resource_recovery_required", true);
        if (macHostText(reply, "commandId", 256) !== commandId || macHostDigest(reply, "commandDigest") !== digest) {
          throw new MacHostBrokerError("command_identity_changed", true);
        }
        if (macHostText(reply, "commandClosed", 5) === "true" || state === "closed") {
          const code = Number(macHostNumber(reply, "exitCode")), signal = Number(macHostNumber(reply, "signal"));
          return { exitCode: code <= 255 ? code : null, signal: signal ? String(signal) : null,
            stdout: new TextDecoder().decode(reply.get("stdout") ?? Buffer.alloc(0), { stream: true }),
            stderr: new TextDecoder().decode(reply.get("stderr") ?? Buffer.alloc(0), { stream: true }),
            truncated: macHostText(reply, "truncated", 5) === "true", timedOut: macHostText(reply, "timedOut", 5) === "true",
            outputClosed: false };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    })().catch((error: unknown) => {
      const stoppedBeforeCommand = this.sealed && error instanceof MacHostBrokerError &&
        error.reason === "attempt_sealed" && !error.outcomeUnknown;
      if (this.mayHaveScope && !stoppedBeforeCommand) this.markUnknown(error);
      throw error;
    }).finally(() => { if (this.command === operation) this.command = null; });
    this.command = operation; return operation;
  }

  seal(): Promise<void> {
    this.sealed = true;
    this.closing ??= (async () => {
      if (this.preparation) await this.preparation;
      if (!this.mayHaveScope) this.closedProof = Object.freeze({ kind: "not_prepared" });
      else {
        if (!this.capability) throw new MacHostBrokerError("scope_preparation_unconfirmed", true);
        this.readScope(await this.scoped("seal"));
        for (;;) {
          const reply = await this.scoped("scopeStatus"), state = this.readScope(reply);
          if (state === "unknown") throw new MacHostBrokerError("resource_recovery_required", true);
          if (state === "closed" && macHostText(reply, "quiescent", 5) === "true") {
            this.closedProof = Object.freeze({ kind: "broker_closed", generation: this.generation,
              policySHA256: this.options.expectedPolicySHA256, scopeSHA256: this.scopeSHA256, capability: this.capability,
              policyGeneration: this.options.expectedPolicyGeneration, resourceId: this.resourceId!, resourceGeneration: this.resourceGeneration!, ...this.identity });
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      if (this.command) await this.command.catch(() => undefined);
      if (this.capability) this.readScope(await this.scoped("retireScope"));
      await this.bridge.end();
      this.physicallyClosed = true; this.resolveClosed();
    })().catch((error: unknown) => { this.markUnknown(error); throw error; });
    return this.closing;
  }
  private prepare(): Promise<void> {
    this.preparation ??= (async () => {
      this.mayHaveScope = true;
      const reply = await this.bridge.request({ ...base("prepareScope", this.generation), ...this.input.attempt,
        policy: this.options.expectedPolicySHA256, policyGeneration: this.options.expectedPolicyGeneration, ...this.metadataFields });
      response(reply); this.capability = macHostDigest(reply, "capability");
      this.resourceId = macHostDigest(reply, "resourceId"); this.resourceGeneration = macHostDigest(reply, "resourceGeneration");
      this.readScope(reply);
    })();
    return this.preparation;
  }
  private scoped(operation: string, fields: Readonly<Record<string, string>> = {}): Promise<Reply> {
    if (!this.capability) return Promise.reject(new MacHostBrokerError("scope_preparation_unconfirmed", true));
    return this.bridge.request({ ...base(operation, this.generation), capability: this.capability, ...fields });
  }
  private readScope(reply: Reply): string {
    const state = response(reply);
    if (macHostDigest(reply, "generation") !== this.generation || macHostDigest(reply, "policy") !== this.options.expectedPolicySHA256 ||
        macHostDigest(reply, "policyGeneration") !== this.options.expectedPolicyGeneration ||
        macHostDigest(reply, "resourceId") !== this.resourceId || macHostDigest(reply, "resourceGeneration") !== this.resourceGeneration ||
        macHostDigest(reply, "capability") !== this.capability || macHostDigest(reply, "scopeSHA256") !== this.scopeSHA256 ||
        macHostDigest(reply, "metadataSHA256") !== this.metadataSHA256 ||
        Object.entries(this.identity).some(([key, value]) => macHostNumber(reply, key) !== value)) throw new MacHostBrokerError("resource_identity_changed", true);
    return state;
  }
  private markUnknown(error: unknown): void { this.unknown = true; this.rejectClosed(error); }
}
