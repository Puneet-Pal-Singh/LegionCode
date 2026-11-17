import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
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
/** Structural port for the EXISTING physical writer owner's release receipt.
 * Its tracked resource consumer runs after the full captured/manifest Git proof
 * and original writer FD closure. No new release registry or boolean proof. */
export interface MacHostPhysicalWriterReleaseReceipt {
  readonly root: Readonly<{ device: string; inode: string }>;
  readonly gitMetadataIdentity: string;
  readonly writerFence: Readonly<{
    namespace: Readonly<{ device: string; inode: string }>;
    lease: Readonly<{ device: string; inode: string }>;
  }>;
}
export type MacHostInstalledDescriptor = Readonly<
  { state: "configured"; options: MacHostBrokerOptions; generation: string; configurationSHA256: string } |
  { state: "unconfigured"; reason: "unsupportedPlatform" | "installedBrokerUnavailable" | "installedServiceUnavailable" |
    "installedAuthorityUnavailable" | "invalidInstalledDescriptor" | "installedDescriptorTimeout" }
>;
const INSTALLED_HOST_BROKER = "/Library/PrivilegedHelperTools/dev.legioncode.desktop.native-host";
/** Main supplies ONLY the independently trusted CURRENT app helper from its
 * private canonical resolveHelper owner, never renderer/config/descriptor input.
 * Canonical/path assertions below do not establish executable/ACL trust. The
 * trusted bundled C reader validates the fixed installed ROOT target BEFORE
 * contact and NEVER executes that target. Configured is not runtime readiness. */
export function readInstalledMacHostBrokerDescriptor(input: { readonly trustedReaderPath: string }): Promise<MacHostInstalledDescriptor> {
  if (process.platform !== "darwin") return Promise.resolve(Object.freeze({ state: "unconfigured", reason: "unsupportedPlatform" }));
  try {
    if (!isAbsolute(input.trustedReaderPath) || input.trustedReaderPath === INSTALLED_HOST_BROKER ||
        realpathSync(input.trustedReaderPath) !== input.trustedReaderPath) throw new Error();
  } catch { return Promise.resolve(Object.freeze({ state: "unconfigured", reason: "invalidInstalledDescriptor" })); }
  return new Promise((resolve) => {
    const child = spawn(input.trustedReaderPath, ["--describe-installed"], { stdio: ["ignore", "pipe", "pipe"], env: {}, shell: false, windowsHide: true });
    let bytes = Buffer.alloc(0), diagnostics = 0, failed = false, timedOut = false, killed = false;
    const stop = () => { if (!killed) { killed = true; child.kill("SIGKILL"); } };
    const timer = setTimeout(() => { timedOut = true; stop(); }, 10000);
    child.on("error", () => { failed = true; });
    child.stdout.on("error", () => { failed = true; stop(); });
    child.stderr.on("error", () => { failed = true; stop(); });
    child.stdout.on("data", (chunk: Buffer) => {
      if (bytes.length + chunk.length > MAC_HOST_MAX_FRAME + 4) { failed = true; stop(); return; }
      bytes = Buffer.concat([bytes, chunk]);
    });
    child.stderr.on("data", (chunk: Buffer) => { diagnostics += chunk.length; if (diagnostics > 1024) { failed = true; stop(); } });
    /* 'close' follows the ORIGINAL process exit and its stdio closure. No
     * decoded bytes are adopted before this original invocation is closed. */
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const unavailable = (reason: Extract<MacHostInstalledDescriptor, { state: "unconfigured" }>["reason"]) =>
        resolve(Object.freeze({ state: "unconfigured", reason }));
      if (timedOut) return unavailable("installedDescriptorTimeout");
      if (failed || code !== 0 || signal !== null) return unavailable("installedBrokerUnavailable");
      try {
        if (bytes.length < 6 || bytes.readUInt32BE(0) !== bytes.length - 4) throw new Error();
        const reply = decodeMacHostFrame(bytes.subarray(4));
        if (macHostText(reply, "version", 8) !== MAC_HOST_BROKER_ABI) throw new Error();
        const state = macHostText(reply, "state", 40), reason = macHostText(reply, "code", 128);
        if (state === "unconfigured") {
          if (reply.size !== 3 || !["installedBrokerUnavailable", "installedServiceUnavailable", "installedAuthorityUnavailable"].includes(reason)) throw new Error();
          return unavailable(reason as Extract<MacHostInstalledDescriptor, { state: "unconfigured" }>["reason"]);
        }
        const keys = ["version", "state", "code", "serviceCodeRequirement", "bridgePath", "policy", "policyGeneration", "generation", "configurationSHA256"];
        if (state !== "configured" || reason !== "okay" || reply.size !== keys.length || keys.some((key) => !reply.has(key))) throw new Error();
        const bridgePath = macHostText(reply, "bridgePath", 1023), serviceCodeRequirement = macHostText(reply, "serviceCodeRequirement", 4096);
        if (!isAbsolute(bridgePath) || bridgePath.includes("\0") || !/^cdhash H"(?:[a-f0-9]{2}){20,64}"$/u.test(serviceCodeRequirement)) throw new Error();
        const options = Object.freeze({ bridgePath, serviceCodeRequirement, expectedPolicySHA256: macHostDigest(reply, "policy"),
          expectedPolicyGeneration: macHostDigest(reply, "policyGeneration") });
        resolve(Object.freeze({ state: "configured", options, generation: macHostDigest(reply, "generation"),
          configurationSHA256: macHostDigest(reply, "configurationSHA256") }));
      } catch { unavailable("invalidInstalledDescriptor"); }
    });
  });
}
export interface MacHostCommandResource {
  readonly closed: Promise<void>;
  readonly quiescent: boolean;
  readonly closure: Readonly<{ kind: "not_prepared" } | ({ kind: "broker_closed"; generation: string; policySHA256: string;
    scopeSHA256: string; capability: string; resourceId: string; resourceGeneration: string; policyGeneration: string } & Identity)> | null;
  seal(): Promise<void>;
  /** Invoke ONLY from LocalWorkspaceWriterLeaseOwner.releaseAttempt(...,
   * combinedCaptureAndGitProof, onReleased). closed/quiescent alone is not this
   * final retirement barrier. Rejection leaves the root UID slot unavailable. */
  onPhysicalWriterReleased(receipt: MacHostPhysicalWriterReleaseReceipt): Promise<void>;
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
    else if (!root && !fence && namespace) stdio.push("ignore", "ignore", namespace.fd);
    else if (root || fence) throw new MacHostBrokerError("invalid_original_authority", false);
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

export type MacHostSetupDescription = Readonly<{
  state: "available" | "blocked";
  reason: "okay" | "setupAuthorizationRequired" | "setupPlatformMismatch" | "qualificationRunnerUnavailable";
  generation: string; configurationSHA256: string;
}>;
export type MacHostSetupObservation = Readonly<
  { state: "not_started" } |
  { state: "running" | "awaiting_bridge" | "passed" | "cancelled" | "unknown";
    generation: string; qualificationId: string; stage: string; receiptSHA256: string | null }
>;
/** Deny-only setup admission observation, never a permit or qualified runtime. */
export type MacHostReauthorizationSealObservation = Readonly<{
  state: "pending" | "ready" | "blocked";
  generation: string; configurationSHA256: string; sealSHA256: string;
}>;
/** Private setup facade over the SAME authenticated bridge. It is neither a
 * qualified runtime client nor a replacement physical-writer proof owner. */
export class MacHostBrokerSetupClient {
  private constructor(private readonly options: MacHostBrokerOptions) {}
  static create(options: MacHostBrokerOptions): MacHostBrokerSetupClient {
    return new MacHostBrokerSetupClient(validateOptions(options));
  }
  async sealForReauthorization(input: { generation: string; configurationSHA256: string }): Promise<MacHostReauthorizationSealObservation> {
    const { generation, configurationSHA256 } = input;
    this.digest(generation); this.digest(configurationSHA256);
    return this.exchange("setupReauthorizationSeal", { generation, configurationSHA256 }, (reply) => {
      const state = macHostText(reply, "state", 40), code = macHostText(reply, "code", 128);
      if (state === "unavailable" && code === "reauthorizationIdentityChanged") {
        this.validate(reply, ["version", "state", "code"]);
        throw new MacHostBrokerError(code, true);
      }
      this.validate(reply, ["version", "state", "code", "generation", "configurationSHA256", "sealSHA256"]);
      const states = { reauthorizationPending: "pending", reauthorizationReady: "ready", reauthorizationBlocked: "blocked" } as const;
      if ((state !== "reauthorizationPending" && state !== "reauthorizationReady" && state !== "reauthorizationBlocked") ||
          code !== (state === "reauthorizationBlocked" ? "reauthorizationRecoveryRequired" : "okay"))
        throw new MacHostBrokerError("invalid_reauthorization_seal", true);
      const returnedGeneration = macHostDigest(reply, "generation"), returnedConfiguration = macHostDigest(reply, "configurationSHA256");
      const sealSHA256 = macHostDigest(reply, "sealSHA256");
      if (returnedGeneration !== generation || returnedConfiguration !== configurationSHA256)
        throw new MacHostBrokerError("reauthorization_identity_changed", true);
      if (state === "reauthorizationReady" && /^0+$/u.test(sealSHA256))
        throw new MacHostBrokerError("invalid_reauthorization_seal", true);
      return Object.freeze({ state: states[state as keyof typeof states], generation: returnedGeneration,
        configurationSHA256: returnedConfiguration, sealSHA256 });
    });
  }
  async describe(): Promise<MacHostSetupDescription> {
    return this.exchange("setupQualificationDescribe", {}, (reply) => {
      const keys = ["version", "state", "code", "generation", "configurationSHA256", "policy", "policyGeneration"];
      this.validate(reply, keys);
      const reason = macHostText(reply, "code", 128), state = macHostText(reply, "state", 40);
      if (!((state === "setupReady" && reason === "okay") || (state === "setupBlocked" &&
          ["setupAuthorizationRequired", "setupPlatformMismatch", "qualificationRunnerUnavailable"].includes(reason))) ||
          macHostDigest(reply, "policy") !== this.options.expectedPolicySHA256 ||
          macHostDigest(reply, "policyGeneration") !== this.options.expectedPolicyGeneration)
        throw new MacHostBrokerError("invalid_setup_description", true);
      return Object.freeze({ state: state === "setupReady" ? "available" : "blocked", reason: reason as MacHostSetupDescription["reason"],
        generation: macHostDigest(reply, "generation"), configurationSHA256: macHostDigest(reply, "configurationSHA256") });
    });
  }
  async start(input: { generation: string; setupPermitId: string; namespaceDirectory: FileHandle }): Promise<MacHostSetupObservation> {
    this.digest(input.generation); this.digest(input.setupPermitId);
    const namespace = fstatSync(input.namespaceDirectory.fd, { bigint: true });
    if (!namespace.isDirectory() || (namespace.mode & 0o777n) !== 0o700n) throw new MacHostBrokerError("invalid_setup_namespace", false);
    const original = await this.exchange("setupQualificationStart", { generation: input.generation, setupPermitId: input.setupPermitId },
      (reply) => {
        const observation = this.observation(reply, ["bridgeNonce"]);
        if (observation.state === "not_started" || observation.generation !== input.generation) throw new MacHostBrokerError("setup_identity_changed", true);
        return { observation, nonce: macHostDigest(reply, "bridgeNonce") };
      }, input.namespaceDirectory);
    /* exchange returns ONLY after ORIGINAL Start Bridge.end, child 'close' and
     * all original stdio close. This private root nonce is never exposed to Main
     * UI/renderer and cannot assert normal UID/physical writer settlement. */
    if (original.observation.state === "unknown") return original.observation;
    for (let i = 0; i < 50; i++) {
      const acknowledgement = await this.exchange("setupQualificationBridgeClosed", {
        generation: input.generation, qualificationId: original.observation.qualificationId, bridgeNonce: original.nonce,
      }, (reply) => {
        const observation = this.observation(reply, ["bridgeConfirmed"]);
        if (observation.state === "not_started" || observation.qualificationId !== original.observation.qualificationId || observation.generation !== input.generation)
          throw new MacHostBrokerError("setup_identity_changed", true);
        const confirmation = macHostText(reply, "bridgeConfirmed", 5);
        if (confirmation !== "true" && confirmation !== "false") throw new MacHostBrokerError("invalid_setup_reply", true);
        return { observation, confirmed: confirmation === "true" };
      });
      if (acknowledgement.confirmed || acknowledgement.observation.state === "unknown") return acknowledgement.observation;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new MacHostBrokerError("original_setup_bridge_disconnect_unconfirmed", true);
  }
  status(input: { generation: string; qualificationId: string }): Promise<MacHostSetupObservation> {
    return this.observe("setupQualificationStatus", input);
  }
  cancel(input: { generation: string; qualificationId: string }): Promise<MacHostSetupObservation> {
    return this.observe("setupQualificationCancel", input);
  }
  private observe(operation: string, input: { generation: string; qualificationId: string }): Promise<MacHostSetupObservation> {
    this.digest(input.generation); this.digest(input.qualificationId);
    return this.exchange(operation, input, (reply) => {
      const observation = this.observation(reply);
      if (observation.state !== "not_started" && (observation.generation !== input.generation || observation.qualificationId !== input.qualificationId))
        throw new MacHostBrokerError("setup_identity_changed", true);
      return observation;
    });
  }
  private digest(value: string): void {
    if (typeof value !== "string" || value.length !== 64 || !/^[a-f0-9]{64}$/u.test(value))
      throw new MacHostBrokerError("invalid_setup_identity", false);
  }
  private validate(reply: Reply, keys: readonly string[]): void {
    if (reply.size !== keys.length || keys.some((key) => !reply.has(key)) || macHostText(reply, "version", 8) !== MAC_HOST_BROKER_ABI)
      throw new MacHostBrokerError("invalid_setup_reply", true);
  }
  private observation(reply: Reply, additional: readonly string[] = []): MacHostSetupObservation {
    const state = macHostText(reply, "state", 40), code = macHostText(reply, "code", 128);
    if (state === "unknown" && code === "setupQualificationNotStarted" && !additional.length) {
      this.validate(reply, ["version", "state", "code"]); return Object.freeze({ state: "not_started" });
    }
    this.validate(reply, ["version", "state", "code", "generation", "qualificationId", "stage", "receiptSHA256", ...additional]);
    const states = { setupRunning: "running", setupAwaitingBridge: "awaiting_bridge", setupPassed: "passed", setupCancelled: "cancelled", unknown: "unknown" } as const;
    if (!(state in states) || (state === "unknown" ? code !== "qualificationRecoveryRequired" : code !== "okay")) throw new MacHostBrokerError(code, true);
    const receipt = macHostDigest(reply, "receiptSHA256"), stage = macHostText(reply, "stage", 40);
    const stages = ["history", "acquiringWriter", "inspectingMetadata", "networkControl", "packageTest", "packageBuild", "checkingStop", "closing", "awaitingBridge", "passed", "cancelled", "recoveryRequired"];
    if (!stages.includes(stage) || (state === "setupPassed" ? /^0+$/u.test(receipt) || stage !== "passed" : !/^0+$/u.test(receipt)))
      throw new MacHostBrokerError("invalid_setup_receipt", true);
    return Object.freeze({ state: states[state as keyof typeof states], generation: macHostDigest(reply, "generation"),
      qualificationId: macHostDigest(reply, "qualificationId"), stage, receiptSHA256: state === "setupPassed" ? receipt : null });
  }
  private async exchange<T>(operation: string, fields: Readonly<Record<string, string>>, decode: (reply: Reply) => T,
    namespace?: FileHandle): Promise<T> {
    const bridge = new Bridge(this.options, undefined, undefined, namespace);
    try { return decode(await bridge.request({ ...base(operation), ...fields })); }
    finally { await bridge.end(); }
  }
}

/** Obtained only from the actual authenticated installed service. This check is
 * observational: no account, UID, file ACL, workspace or command is created. */
export class MacHostBrokerClient {
  private constructor(private readonly options: MacHostBrokerOptions, readonly generation: string) {}
  /** Installed setup only; never relaxes the normal ready-required connect. */
  static setup(input: MacHostBrokerOptions): MacHostBrokerSetupClient { return MacHostBrokerSetupClient.create(input); }
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
  private retirement: Promise<void> | null = null;
  private retirementNonce: string | null = null;
  private cleanupReceipt: string | null = null;
  private slotGeneration: bigint | null = null;
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
    let rejectedBeforeCommand = false;
    const operation = (async () => {
      await this.prepare();
      if (this.sealed) throw new MacHostBrokerError("attempt_sealed", false);
      const digest = macHostCommandDigest(command, cwd);
      const prepared = await this.scoped("prepareCommand", { commandId, command, cwd, ...metadataFields });
      if (macHostText(prepared, "state", 40) === "busy") {
        // Only this authenticated, exact-request rejection proves that prepare
        // made no command or access-journal effects. A lost/malformed reply
        // still retains the original resource fence; never retry the command.
        if (macHostText(prepared, "version", 8) !== MAC_HOST_BROKER_ABI ||
            macHostText(prepared, "code", 128) !== "actorAccessEpochBusy" ||
            macHostText(prepared, "requestedCommandId", 256) !== commandId ||
            macHostDigest(prepared, "requestedCommandDigest") !== digest)
          throw new MacHostBrokerError("command_rejection_identity_changed", true);
        this.assertScopeIdentity(prepared);
        rejectedBeforeCommand = true;
        throw new MacHostBrokerError("actorAccessEpochBusy", false);
      }
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
      if (this.mayHaveScope && !stoppedBeforeCommand && !rejectedBeforeCommand) this.markUnknown(error);
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
      if (this.capability) {
        const reply = await this.scoped("retireScope"); this.readScope(reply);
        this.retirementNonce = macHostDigest(reply, "retirementNonce");
        this.cleanupReceipt = macHostDigest(reply, "cleanupReceipt");
        this.slotGeneration = macHostNumber(reply, "slotGeneration");
        if (!this.slotGeneration || /^0+$/u.test(this.retirementNonce) || /^0+$/u.test(this.cleanupReceipt))
          throw new MacHostBrokerError("invalid_retirement_authority", true);
      }
      await this.bridge.end();
      this.physicallyClosed = true; this.resolveClosed();
    })().catch((error: unknown) => { this.markUnknown(error); throw error; });
    return this.closing;
  }
  /** Separate from seal(): the physical writer cannot release until closed is
   * fulfilled, so putting this confirmation in closed would deadlock its owner.
   * Original bridge.end includes its actual child 'close' and all stdio closure. */
  onPhysicalWriterReleased(receipt: MacHostPhysicalWriterReleaseReceipt): Promise<void> {
    const identities = [receipt.root, receipt.writerFence.namespace, receipt.writerFence.lease];
    const expected = [this.identity.rootDevice, this.identity.rootInode, this.identity.namespaceDevice,
      this.identity.namespaceInode, this.identity.fenceDevice, this.identity.fenceInode];
    const values = identities.flatMap((value) => [value.device, value.inode]);
    if (!this.quiescent || values.some((value, i) => !/^[0-9a-f]{1,16}$/u.test(value) || BigInt("0x" + value) !== expected[i]) ||
        receipt.gitMetadataIdentity !== this.input.metadataLayout.identity)
      return Promise.reject(new MacHostBrokerError("physical_writer_release_identity_changed", true));
    this.retirement ??= (async () => {
      if (!this.mayHaveScope) return;
      if (!this.retirementNonce || !this.cleanupReceipt || !this.slotGeneration || !this.capability ||
          !this.resourceId || !this.resourceGeneration) throw new MacHostBrokerError("retirement_authority_missing", true);
      const hash = createHash("sha256").update("LegionCode/native-host/physical-retirement/v1\0");
      for (const value of [this.retirementNonce, this.cleanupReceipt, this.resourceId, this.resourceGeneration]) hash.update(Buffer.from(value, "hex"));
      for (const value of [this.slotGeneration, ...expected]) {
        const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(value); hash.update(bytes);
      }
      hash.update(receipt.gitMetadataIdentity + "\0");
      const fields = { ...base("confirmResourceRetirement", this.generation), capability: this.capability,
        resourceId: this.resourceId, resourceGeneration: this.resourceGeneration, slotGeneration: this.slotGeneration.toString(),
        cleanupReceipt: this.cleanupReceipt, retirementNonce: this.retirementNonce, hostReleaseSHA256: hash.digest("hex") };
      const bridge = new Bridge(this.options);
      try {
        /* Repeating this metadata-only confirmation may ONLY observe the old
         * receipt. No retry here can create a command, UID or physical writer. */
        for (let i = 0; i < 50; i++) {
          const state = response(await bridge.request(fields));
          if (state === "retired") return;
          if (state !== "retirementPending") throw new MacHostBrokerError("invalid_retirement_reply", true);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new MacHostBrokerError("original_bridge_disconnect_unconfirmed", true);
      } finally { await bridge.end(); }
    })();
    return this.retirement;
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
    this.assertScopeIdentity(reply);
    return state;
  }
  private assertScopeIdentity(reply: Reply): void {
    if (macHostDigest(reply, "generation") !== this.generation || macHostDigest(reply, "policy") !== this.options.expectedPolicySHA256 ||
        macHostDigest(reply, "policyGeneration") !== this.options.expectedPolicyGeneration ||
        macHostDigest(reply, "resourceId") !== this.resourceId || macHostDigest(reply, "resourceGeneration") !== this.resourceGeneration ||
        macHostDigest(reply, "capability") !== this.capability || macHostDigest(reply, "scopeSHA256") !== this.scopeSHA256 ||
        macHostDigest(reply, "metadataSHA256") !== this.metadataSHA256 ||
        Object.entries(this.identity).some(([key, value]) => macHostNumber(reply, key) !== value)) throw new MacHostBrokerError("resource_identity_changed", true);
  }
  private markUnknown(error: unknown): void { this.unknown = true; this.rejectClosed(error); }
}
