import { gitCommandRunnerArgs, gitCommandRunnerEnvironment, parseGitIndexTransactionResult, type GitCommandExecutionInput } from "@repo/git-service/executor";
import { NativeCheckoutBootstrapIntentSchema, type NativeCheckoutBootstrapReceipt } from "@repo/worker-protocol/private/native-checkout-bootstrap";
import { materializeNativeCheckout } from "./NativeCheckoutMaterialization";
import { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox";
import {
  NativeCommandBindingSchema, NativeCommandReceiptSchema, NativeCommandRequestSchema,
  NativeWorkspacePreparationSchema, NativeWorkspaceWriteReceiptSchema, sameNativeBinding,
  type NativeCommandOriginal, type NativeCommandRequest, type NativeCommandBinding, type OwnedNativeSandboxPort,
} from "../toolbox/contracts/OwnedSandboxCommand";

import { authorizeQualification, type QualificationAuthorization } from "../qualification/NativeBoundaryQualificationAuth";
import { RESOURCE_POLICY, ResourceSetupBindingSchema, ResourceObservationSchema, ResourceProvisionReceiptSchema,
  ResourceObservationInputSchema, ResourceProvisionInputSchema, freezeQualification,
  type ResourceSetupBinding, type QualificationRawAction, QualificationNamespaceInputSchema, QualificationFixtureSchema,
  QualificationNamespaceReceiptSchema, QualificationMarkersSchema } from "../qualification/contracts";
import { NativeResourceSetupBindingSchema, NativeResourceObservationSchema, NativeResourceProvisionReceiptSchema, NativeRuntimePreparationSchema } from "../qualification/contracts";
import type { Env } from "../index";

const helper = "/usr/local/libexec/legioncode-command-supervisor";
const enterControl = `printf '%s' "$$" > /sys/fs/cgroup/legioncode-native/control/cgroup.procs && exec ${helper} --serve`;
const encoder = new TextEncoder();

/** Same configured Sandbox DO and backend. AgentRuntime retains durable intent. */
export class Sandbox extends CloudflareSandbox implements OwnedNativeSandboxPort {
  private readonly nativeState: DurableObjectState;
  private readonly nativeEnvironment: Env;
  private nativeOriginal: Promise<unknown> | undefined;
  private nativeBootstrapCreator?: <T>(binding: NativeCommandBinding, effect: (deadline: number) => Promise<T>, readOnly?: boolean) => Promise<T>;
  private nativeRuntimeObserver?: (binding: NativeCommandBinding, preparation: unknown) => Promise<void>;
  private nativeBootstrap?: { binding: NativeCommandBinding; sealed: boolean; creators: Set<Promise<unknown>> };

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
    const runtimeProbe = input.argv.length === 2 && input.argv[0] === helper && input.argv[1] === "--native-runtime-payload";
    if (runtimeProbe && !this.nativeBootstrapCreator) throw unavailable();
    const original = this.nativeBootstrapCreator && runtimeProbe
      ? this.nativeBootstrapCreator(input.binding, deadline => this.runOriginal(["/bin/sh", "-c", enterControl], input, 64 * 1024, deadline))
      : this.runOriginal(["/bin/sh", "-c", enterControl], input);
    this.nativeOriginal = original;
    try { return await original; }
    finally { if (this.nativeOriginal === original) this.nativeOriginal = undefined; }
  }

  async controlNativeCommand(input: Parameters<OwnedNativeSandboxPort["controlNativeCommand"]>[0]) {
    const binding = NativeCommandBindingSchema.parse(input.binding);
    if (input.action === "start" && this.nativeBootstrap &&
      sameNativeBinding(this.nativeBootstrap.binding, { ...binding, nonce: this.nativeBootstrap.binding.nonce })) {
      if (!this.nativeBootstrapCreator) throw unavailable();
      return this.nativeBootstrapCreator(binding, () => this.readNativeCommandControl(input));
    }
    return this.readNativeCommandControl(input);
  }

  private async readNativeCommandControl(input: Parameters<OwnedNativeSandboxPort["controlNativeCommand"]>[0]) {
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

  async verifyNativeRuntimeOriginal(binding: NativeCommandBinding, preparation: unknown): Promise<void> {
    if (!this.nativeRuntimeObserver) throw unavailable();
    await this.nativeRuntimeObserver(binding, preparation);
  }

  async sealNativeBootstrap(value: NativeCommandBinding): Promise<void> {
    const binding = NativeCommandBindingSchema.parse(value);
    const current = this.nativeBootstrap;
    if (current && !sameNativeBinding(current.binding, { ...binding, nonce: current.binding.nonce })) throw unavailable();
    const gate = current ?? { binding, sealed: true, creators: new Set<Promise<unknown>>() };
    this.nativeBootstrap = gate;
    // Synchronous physical admission fence, before waiting for any creator.
    gate.sealed = true;
    await Promise.allSettled([...gate.creators]);
    if (this.nativeOriginal) await Promise.allSettled([this.nativeOriginal]);
  }

  async materializeNativeCheckout(input: Parameters<NonNullable<OwnedNativeSandboxPort["materializeNativeCheckout"]>>[0]) {
    const binding = NativeCommandBindingSchema.parse(input.binding);
    const intent = NativeCheckoutBootstrapIntentSchema.parse(input.intent);
    if (this.nativeOriginal || this.nativeBootstrap) throw unavailable();
    const gate = { binding, sealed: false, creators: new Set<Promise<unknown>>() };
    this.nativeBootstrap = gate;
    const gitReceipts: NativeCheckoutBootstrapReceipt["git"] = [];
    const owner = this.nativeEnvironment.AGENT_RUNTIME.get(this.nativeEnvironment.AGENT_RUNTIME.idFromString(input.physicalOwnerId));
    const originalContainer = this.nativeState.container;
    const inspect = async (): Promise<unknown> => {
      // Feature detection is not evidence: validate each actual provider result.
      const candidate: unknown = originalContainer;
      if (!candidate || typeof candidate !== "object" || !("inspect" in candidate) || typeof candidate.inspect !== "function") throw unavailable();
      return await candidate.inspect();
    };
    let observedImage: { reference: string; digest: string } | undefined;
    const readImage = async () => {
      const result = await inspect();
      if (!result || typeof result !== "object" || !("image" in result) || typeof result.image !== "string" ||
        result.image.length > 2048 || !/^(?:[A-Za-z0-9._:/-]+@)?sha256:[a-f0-9]{64}$/.test(result.image)) throw unavailable();
      return { reference: result.image, digest: result.image.slice(-71) };
    };
    const physicalAdmission = (deadline: number) => {
      if (gate.sealed || deadline <= Date.now() || this.nativeState.container !== originalContainer) throw unavailable();
    };
    const create = async <T>(creatorBinding: NativeCommandBinding, effect: (deadline: number) => Promise<T>, readOnly = false): Promise<T> => {
      // Register the entire pending authorization/creator before any effect.
      const creator = Promise.resolve().then(async () => {
        const admission = await owner.continueNativeBootstrap(creatorBinding, this.nativeState.id.toString(), intent, readOnly);
        if (!admission) throw unavailable();
        // No await between physical Stop/deadline admission and effect dispatch.
        if (observedImage) {
          const image = await readImage();
          if (image.reference !== observedImage.reference || !originalContainer?.running) throw unavailable();
        }
        physicalAdmission(admission.expiresAt);
        return effect(admission.expiresAt);
      });
      gate.creators.add(creator);
      try { return await creator; } finally { gate.creators.delete(creator); }
    };
    this.nativeBootstrapCreator = create;
    const createOriginal = <T>(effect: (deadline: number) => Promise<T>) => create(binding, effect);
    const operation = Promise.resolve().then(async () => {
      if (!await owner.authorizeNativeBootstrap(binding, this.nativeState.id.toString(), intent)) throw unavailable();
      await createOriginal(async deadline => {
        if (!originalContainer || originalContainer.running || await inspect() !== null) throw unavailable();
        if (originalContainer.running) throw unavailable();
        physicalAdmission(deadline);
        await this.startAndWaitForPorts({ ports: this.defaultPort });
      });
      observedImage = await readImage();
      const resourceBinding = NativeResourceSetupBindingSchema.parse({ purpose: "legioncode_native", native: binding,
        physicalOwnerId: input.physicalOwnerId, expiresAt: (await owner.continueNativeBootstrap(binding, this.nativeState.id.toString(), intent))?.expiresAt });
      const fixed = async (mode: string, body: unknown) => {
        const result = await createOriginal(deadline => this.runOriginal([helper, mode], body, 64 * 1024, deadline));
        if (result.exitCode !== 0 || result.stderr !== "") throw unavailable();
        return JSON.parse(result.stdout) as unknown;
      };
      const observation = NativeResourceObservationSchema.parse(await fixed("--observe-resources", { version: 1, binding: resourceBinding, policy: RESOURCE_POLICY }));
      const resources = NativeResourceProvisionReceiptSchema.parse(await fixed("--provision-resources", { version: 1,
        binding: resourceBinding, policy: RESOURCE_POLICY, expectedBootId: observation.sandboxBootId, expectedParent: observation.parent.identity }));
      if (JSON.stringify(observation.binding) !== JSON.stringify(resourceBinding) || JSON.stringify(resources.binding) !== JSON.stringify(resourceBinding) ||
        resources.sandboxBootId !== observation.sandboxBootId) throw unavailable();
      const runtimePreparation = NativeRuntimePreparationSchema.parse({ imageReference: observedImage.reference, imageDigest: observedImage.digest,
        sandboxObjectId: this.nativeState.id.toString(), observation, resources });
      this.nativeRuntimeObserver = async (commandBinding, expected) => {
        const preparation = NativeRuntimePreparationSchema.parse(expected);
        if (JSON.stringify(preparation) !== JSON.stringify(runtimePreparation)) throw unavailable();
        // Read-only original evidence observation: never call SDK startup here.
        const result = await create(commandBinding, deadline => this.runOriginal([helper, "--observe-resources"],
          { version: 1, binding: resourceBinding, policy: RESOURCE_POLICY }, 64 * 1024, deadline), true);
        if (result.exitCode !== 0 || result.stderr !== "") throw unavailable();
        const observed = NativeResourceObservationSchema.parse(JSON.parse(result.stdout));
        if (observed.sandboxBootId !== observation.sandboxBootId || observed.helperSha256 !== observation.helperSha256 ||
          JSON.stringify(observed.binding) !== JSON.stringify(resourceBinding) ||
          JSON.stringify(observed.parent.identity) !== JSON.stringify(observation.parent.identity)) throw unavailable();
      };
      const materialized = await materializeNativeCheckout({
      binding, intent, authEnvironment: input.authEnvironment, gitReceipts,
      original: (argv, body) => createOriginal(deadline => this.runOriginal(argv, body, 64 * 1024, deadline)),
      git: { execute: async (command: GitCommandExecutionInput) => {
        if (command.cwd !== intent.root || gitReceipts.length >= 64) throw unavailable();
        const args = gitCommandRunnerArgs(command), env = gitCommandRunnerEnvironment(command);
        const original = await createOriginal(deadline => this.runOriginal(["/usr/local/bin/node", ...args], {}, 64 * 1024, deadline, { cwd: intent.root, env }));
        if (original.exitCode !== 0 || original.stderr !== "") throw unavailable();
        const result = parseGitIndexTransactionResult(original.stdout);
        if (result.exitCode !== 0 || result.indexPublication || result.artifactConflict) throw unavailable();
        const bytes = encoder.encode(JSON.stringify({ cwd: command.cwd, argv: ["/usr/local/bin/node", ...args] }));
        const commandSha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
        gitReceipts.push({ commandSha256, originalTransportSettled: true });
        return result;
      } },
      });
      if (materialized.receipt.observation.sandboxBootId !== observation.sandboxBootId || materialized.receipt.observation.helperSha256 !== observation.helperSha256) throw unavailable();
      return { ...materialized, runtimePreparation };
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
