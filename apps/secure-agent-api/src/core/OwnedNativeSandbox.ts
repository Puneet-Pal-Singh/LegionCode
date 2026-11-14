import { gitCommandRunnerArgs, gitCommandRunnerEnvironment, parseGitIndexTransactionResult, type GitCommandExecutionInput } from "@repo/git-service/executor";
import { NativeCheckoutBootstrapIntentSchema, type NativeCheckoutBootstrapReceipt } from "@repo/worker-protocol/private/native-checkout-bootstrap";
import { materializeNativeCheckout } from "./NativeCheckoutMaterialization";
import { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox";
import {
  NativeCommandBindingSchema, NativeCommandReceiptSchema, NativeCommandRequestSchema,
  NativeWorkspacePreparationSchema, NativeWorkspaceWriteReceiptSchema, sameNativeBinding,
  type NativeCommandOriginal, type NativeCommandRequest, type OwnedNativeSandboxPort,
} from "../toolbox/contracts/OwnedSandboxCommand";

import { authorizeQualification, type QualificationAuthorization } from "../qualification/NativeBoundaryQualificationAuth";
import { RESOURCE_POLICY, ResourceSetupBindingSchema, ResourceObservationSchema, ResourceProvisionReceiptSchema,
  ResourceObservationInputSchema, ResourceProvisionInputSchema, freezeQualification,
  type ResourceSetupBinding, type QualificationRawAction, QualificationNamespaceInputSchema, QualificationFixtureSchema,
  QualificationNamespaceReceiptSchema, QualificationMarkersSchema } from "../qualification/contracts";
import type { Env } from "../index";

const helper = "/usr/local/libexec/legioncode-command-supervisor";
const enterControl = `printf '%s' "$$" > /sys/fs/cgroup/legioncode-native/control/cgroup.procs && exec ${helper} --serve`;
const encoder = new TextEncoder();

/** Same configured Sandbox DO and backend. AgentRuntime retains durable intent. */
export class Sandbox extends CloudflareSandbox implements OwnedNativeSandboxPort {
  private readonly nativeState: DurableObjectState;
  private readonly nativeEnvironment: Env;
  private nativeOriginal: Promise<unknown> | undefined;

  constructor(state: DurableObjectState<Record<string, never>>, env: unknown) {
    super(state, env);
    this.nativeState = state;
    this.nativeEnvironment = env as Env;
  }

  private async authorizeQualificationRaw(auth: QualificationAuthorization, binding: ResourceSetupBinding,
    action: QualificationRawAction): Promise<void> {
    authorizeQualification(this.nativeEnvironment, auth);
    const ownerId = this.nativeEnvironment.AGENT_RUNTIME.idFromString(binding.physicalOwnerId);
    const allowed = await this.nativeEnvironment.AGENT_RUNTIME.get(ownerId).qualificationAdmitRaw(
      auth, binding, this.nativeState.id.toString(), action);
    if (!allowed || (!["retire", "verify"].includes(action) && binding.expiresAt <= Date.now())) throw unavailable();
  }

  private async continueQualificationRaw(auth: QualificationAuthorization, binding: ResourceSetupBinding,
    action: Exclude<QualificationRawAction, "retire">): Promise<void> {
    const ownerId = this.nativeEnvironment.AGENT_RUNTIME.idFromString(binding.physicalOwnerId);
    const allowed = await this.nativeEnvironment.AGENT_RUNTIME.get(ownerId).qualificationContinueRaw(
      auth, binding, this.nativeState.id.toString(), action);
    if (!allowed || (action !== "verify" && binding.expiresAt <= Date.now())) throw unavailable();
  }

  async qualificationObserveResources(auth: QualificationAuthorization, value: unknown) {
    const input = freezeQualification(ResourceObservationInputSchema.parse(value));
    if (input.version !== 1 || input.policy !== RESOURCE_POLICY || this.nativeOriginal) throw unavailable();
    const original = Promise.resolve().then(async () => {
      await this.authorizeQualificationRaw(auth, input.binding, "observe");
      if (!this.nativeState.container || this.nativeState.container.running) throw unavailable();
      // The exclusive persisted operator grant precedes the SAME SDK startup,
      // image entrypoint and default policy. No customer env or alternate engine.
      if (input.binding.expiresAt <= Date.now()) throw unavailable();
      await this.startAndWaitForPorts({ ports: this.defaultPort });
      await this.continueQualificationRaw(auth, input.binding, "observe");
      return this.runOriginal([helper, "--observe-resources"], input, 64 * 1024, input.binding.expiresAt);
    });
    this.nativeOriginal = original;
    try {
      const result = await original;
      if (result.exitCode !== 0 || result.stderr !== "") throw unavailable();
      return ResourceObservationSchema.parse(JSON.parse(result.stdout));
    } finally { if (this.nativeOriginal === original) this.nativeOriginal = undefined; }
  }

  async qualificationProvisionResources(auth: QualificationAuthorization, value: unknown) {
    const input = freezeQualification(ResourceProvisionInputSchema.parse(value));
    if (input.version !== 1 || input.policy !== RESOURCE_POLICY || this.nativeOriginal) throw unavailable();
    const original = Promise.resolve().then(async () => {
      await this.authorizeQualificationRaw(auth, input.binding, "provision");
      await this.continueQualificationRaw(auth, input.binding, "provision");
      return this.runOriginal([helper, "--provision-resources"], input, 64 * 1024, input.binding.expiresAt);
    });
    this.nativeOriginal = original;
    try {
      const result = await original;
      if (result.exitCode !== 0 || result.stderr !== "") throw unavailable();
      return ResourceProvisionReceiptSchema.parse(JSON.parse(result.stdout));
    } finally { if (this.nativeOriginal === original) this.nativeOriginal = undefined; }
  }

  async qualificationFixture(auth: QualificationAuthorization, value: unknown, mode: "prepare" | "observe") {
    const input = freezeQualification(QualificationNamespaceInputSchema.parse(value));
    if (this.nativeOriginal || (mode !== "prepare" && mode !== "observe")) throw unavailable();
    const action = mode === "prepare" ? "fixture" : "verify";
    const original = Promise.resolve().then(async () => {
      await this.authorizeQualificationRaw(auth, input.binding, action);
      await this.continueQualificationRaw(auth, input.binding, action);
      return this.runOriginal([helper, mode === "prepare" ? "--prepare-qualification-fixture" : "--observe-qualification-fixture"], input,
        64 * 1024, mode === "prepare" ? input.binding.expiresAt : undefined);
    });
    this.nativeOriginal = original;
    try {
      const result = await original;
      if (result.exitCode !== 0 || result.stderr !== "") throw unavailable();
      return mode === "prepare" ? QualificationFixtureSchema.parse(JSON.parse(result.stdout)) : QualificationMarkersSchema.parse(JSON.parse(result.stdout));
    } finally { if (this.nativeOriginal === original) this.nativeOriginal = undefined; }
  }

  async qualificationStartNamespace(auth: QualificationAuthorization, value: unknown) {
    const input = freezeQualification(QualificationNamespaceInputSchema.parse(value));
    if (this.nativeOriginal || !input.fixture || !input.controlToken) throw unavailable();
    const original = Promise.resolve().then(async () => {
      await this.authorizeQualificationRaw(auth, input.binding, "namespace");
      await this.continueQualificationRaw(auth, input.binding, "namespace");
      const enter = `printf '%s' "$$" > /sys/fs/cgroup/legioncode-native/control/cgroup.procs && exec ${helper} --qualify-namespace`;
      return this.runOriginal(["/bin/sh", "-c", enter], input, 64 * 1024, input.binding.expiresAt);
    });
    this.nativeOriginal = original;
    try {
      const result = await original;
      if (result.exitCode !== 0 || result.stderr !== "") throw unavailable();
      return QualificationNamespaceReceiptSchema.parse(JSON.parse(result.stdout));
    } finally { if (this.nativeOriginal === original) this.nativeOriginal = undefined; }
  }

  async qualificationNamespaceControl(auth: QualificationAuthorization, binding: ResourceSetupBinding, nonce: string,
    token: string, identity: unknown, action: "status" | "start" | "stop" | "ack") {
    authorizeQualification(this.nativeEnvironment, auth);
    ResourceSetupBindingSchema.parse(binding);
    if (!/^[a-f0-9]{64}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(token) || !["status", "start", "stop", "ack"].includes(action)) throw unavailable();
    const ownerId = this.nativeEnvironment.AGENT_RUNTIME.idFromString(binding.physicalOwnerId);
    const allowed = await this.nativeEnvironment.AGENT_RUNTIME.get(ownerId).qualificationAuthorizeNamespaceControl(
      auth, binding, nonce, token, identity, action, this.nativeState.id.toString());
    if (!allowed || (action === "start" && binding.expiresAt <= Date.now())) throw unavailable();
    // Nonwaking transport and full original body drain, including non-200s.
    const response = await this.containerFetchIfRunning(new Request(`http://native-control/v1/${action}`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ binding: { qualification: binding, nonce }, ...(identity ? { identity } : {}) }),
    }), 3101);
    const body = await readBounded(response.body, 256 * 1024);
    if (!response.ok) throw unavailable();
    const receipt = QualificationNamespaceReceiptSchema.parse(JSON.parse(body));
    if (JSON.stringify(receipt.binding) !== JSON.stringify({ qualification: binding, nonce })) throw unavailable();
    return receipt;
  }

  async qualificationDestroy(auth: QualificationAuthorization, binding: ResourceSetupBinding): Promise<void> {
    ResourceSetupBindingSchema.parse(binding);
    await this.authorizeQualificationRaw(auth, binding, "retire");
    if (this.nativeOriginal) throw unavailable();
    await this.destroy();
  }

  async executeNativeCommand(value: NativeCommandRequest): Promise<NativeCommandOriginal> {
    const input = NativeCommandRequestSchema.parse(value);
    const container = this.nativeState.container;
    if (!container?.running || typeof container.exec !== "function" || this.nativeOriginal) {
      throw unavailable();
    }
    // The parent enters its reserved control sibling before it creates any
    // untrusted process. The helper independently checks the real membership.
    // The fixed shell script contains no user data, credentials or identity.
    const original = this.runOriginal(["/bin/sh", "-c", enterControl], input);
    this.nativeOriginal = original;
    try { return await original; }
    finally { if (this.nativeOriginal === original) this.nativeOriginal = undefined; }
  }

  async controlNativeCommand(input: Parameters<OwnedNativeSandboxPort["controlNativeCommand"]>[0]) {
    const binding = NativeCommandBindingSchema.parse(input.binding);
    if (!/^[a-f0-9]{64}$/.test(input.controlToken) || !["status", "start", "stop", "ack"].includes(input.action)) throw unavailable();
    // Do not wake a replacement container or retry an ambiguous creator gate.
    const response = await this.containerFetchIfRunning(new Request(`http://native-control/v1/${input.action}`, {
      method: "POST", headers: { "Authorization": `Bearer ${input.controlToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ binding, ...(input.identity ? { identity: input.identity } : {}) }),
    }), 3101);
    if (!response.ok) { await response.body?.cancel(); throw unavailable(); }
    const receipt = NativeCommandReceiptSchema.parse(JSON.parse(await readBounded(response.body, 12 * 1024 * 1024)));
    if (!sameNativeBinding(receipt.binding, binding)) throw unavailable();
    return receipt;
  }

  async materializeNativeCheckout(input: Parameters<NonNullable<OwnedNativeSandboxPort["materializeNativeCheckout"]>>[0]) {
    const binding = NativeCommandBindingSchema.parse(input.binding);
    const intent = NativeCheckoutBootstrapIntentSchema.parse(input.intent);
    if (this.nativeOriginal) throw unavailable();
    const gitReceipts: NativeCheckoutBootstrapReceipt["git"] = [];
    const owner = this.nativeEnvironment.AGENT_RUNTIME.get(this.nativeEnvironment.AGENT_RUNTIME.idFromString(input.physicalOwnerId));
    const continueOriginal = async () => {
      if (!await owner.continueNativeBootstrap(binding, this.nativeState.id.toString(), intent)) throw unavailable();
    };
    const operation = Promise.resolve().then(async () => {
      if (!await owner.authorizeNativeBootstrap(binding, this.nativeState.id.toString(), intent)) throw unavailable();
      await this.startAndWaitForPorts({ ports: this.defaultPort });
      await continueOriginal();
      return materializeNativeCheckout({
      binding, intent, authEnvironment: input.authEnvironment, gitReceipts,
      original: async (argv, body) => { await continueOriginal(); return this.runOriginal(argv, body); },
      git: { execute: async (command: GitCommandExecutionInput) => {
        if (command.cwd !== intent.root || gitReceipts.length >= 64) throw unavailable();
        const args = gitCommandRunnerArgs(command), env = gitCommandRunnerEnvironment(command);
        await continueOriginal();
        const original = await this.runOriginal(["/usr/local/bin/node", ...args], {}, 64 * 1024, undefined, { cwd: intent.root, env });
        if (original.exitCode !== 0 || original.stderr !== "") throw unavailable();
        const result = parseGitIndexTransactionResult(original.stdout);
        if (result.exitCode !== 0 || result.indexPublication || result.artifactConflict) throw unavailable();
        const bytes = encoder.encode(JSON.stringify({ cwd: command.cwd, argv: ["/usr/local/bin/node", ...args] }));
        const commandSha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
        gitReceipts.push({ commandSha256, originalTransportSettled: true });
        return result;
      } },
      });
    });
    this.nativeOriginal = operation;
    const retained = this.nativeOriginal;
    try { return await operation; }
    finally { if (this.nativeOriginal === retained) this.nativeOriginal = undefined; }
  }

  async prepareNativeWorkspace(input: Parameters<OwnedNativeSandboxPort["prepareNativeWorkspace"]>[0]) {
    NativeCommandBindingSchema.parse(input.binding);
    if (!/^\/home\/sandbox\/checkouts\/[A-Za-z0-9_.-]+$/.test(input.root) || this.nativeOriginal) throw unavailable();
    const operation = this.runOriginal([helper, "--prepare-workspace"], input);
    this.nativeOriginal = operation;
    let original: NativeCommandOriginal;
    try { original = await operation; }
    finally { if (this.nativeOriginal === operation) this.nativeOriginal = undefined; }
    if (original.exitCode !== 0 || original.stderr !== "") throw unavailable();
    const prepared = NativeWorkspacePreparationSchema.parse(JSON.parse(original.stdout));
    if (!sameNativeBinding(prepared.binding, input.binding)) throw unavailable();
    return prepared;
  }

  async writeNativeWorkspaceFile(input: Parameters<NonNullable<OwnedNativeSandboxPort["writeNativeWorkspaceFile"]>>[0]) {
    NativeCommandBindingSchema.parse(input.binding);
    if (this.nativeOriginal) throw unavailable();
    const operation = this.runOriginal([helper, "--write-workspace-file"], input, 2 * 1024 * 1024);
    this.nativeOriginal = operation;
    let original: NativeCommandOriginal;
    try { original = await operation; }
    finally { if (this.nativeOriginal === operation) this.nativeOriginal = undefined; }
    if (original.exitCode !== 0 || original.stderr !== "") throw unavailable();
    const receipt = NativeWorkspaceWriteReceiptSchema.parse(JSON.parse(original.stdout));
    if (!sameNativeBinding(receipt.binding, input.binding)) throw unavailable();
    return receipt;
  }

  private async runOriginal(argv: string[], input: unknown, limit = 64 * 1024, expiresAt?: number, trustedGit?: { cwd: string; env: Record<string, string> }): Promise<NativeCommandOriginal> {
    const container = this.nativeState.container;
    if (!container?.running || typeof container.exec !== "function") throw unavailable();
    const body = encoder.encode(JSON.stringify(input));
    if (body.byteLength > limit) throw unavailable();
    // Check in the synchronous creator section, not before an awaited
    // authorization helper whose continuation may resume past the deadline.
    if (expiresAt !== undefined && expiresAt <= Date.now()) throw unavailable();
    const process = await container.exec(argv, {
      user: "0:0", cwd: trustedGit?.cwd ?? "/", env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", ...(trustedGit?.env ?? {}) },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    if (!process.stdin || !process.stdout || !process.stderr) throw unavailable();
    const stdin = process.stdin;
    const inputSettled = (async () => {
      const writer = stdin.getWriter();
      try { await writer.write(body); await writer.close(); }
      finally { writer.releaseLock(); }
    })();
    // Consume original channels concurrently through EOF, including rejected
    // reads. An observer timeout or a process-status label cannot replace them.
    const settled = await Promise.allSettled([
      readBounded(process.stdout, 12 * 1024 * 1024), readBounded(process.stderr, 4096), process.exitCode, inputSettled,
    ]);
    const [stdout, stderr, exit, inputClosed] = settled;
    if (stdout.status !== "fulfilled" || stderr.status !== "fulfilled" || exit.status !== "fulfilled" || inputClosed.status !== "fulfilled") throw unavailable();
    return { stdout: stdout.value, stderr: stderr.value, exitCode: exit.value };
  }
}

async function readBounded(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<string> {
  if (!stream) throw unavailable();
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let text = "", bytes = 0, invalid = false;
  try {
    while (true) {
      const value = await reader.read();
      if (value.done) break;
      bytes += value.value.byteLength;
      if (bytes > limit) invalid = true;
      if (!invalid) {
        try { text += decoder.decode(value.value, { stream: true }); } catch { invalid = true; }
      }
    }
    if (invalid) throw unavailable();
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}
function unavailable(): Error { return new Error("NATIVE_COMMAND_TRANSPORT_UNAVAILABLE"); }
