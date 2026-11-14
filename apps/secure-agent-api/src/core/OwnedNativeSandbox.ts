import { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox";
import {
  NativeCommandBindingSchema, NativeCommandReceiptSchema, NativeCommandRequestSchema,
  NativeRootIdentitySchema, NativeMetadataProtectionSchema, sameNativeBinding,
  type NativeCommandOriginal, type NativeCommandRequest, type OwnedNativeSandboxPort,
} from "../toolbox/contracts/OwnedSandboxCommand";

const helper = "/usr/local/libexec/legioncode-command-supervisor";
const enterControl = `printf '%s' "$$" > /sys/fs/cgroup/legioncode-native/control/cgroup.procs && exec ${helper} --serve`;
const encoder = new TextEncoder();

/** Same configured Sandbox DO and backend. AgentRuntime retains durable intent. */
export class Sandbox extends CloudflareSandbox implements OwnedNativeSandboxPort {
  private readonly nativeState: DurableObjectState;
  private nativeOriginal: Promise<NativeCommandOriginal> | undefined;

  constructor(state: DurableObjectState<Record<string, never>>, env: unknown) {
    super(state, env);
    this.nativeState = state;
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

  async prepareNativeWorkspace(input: Parameters<OwnedNativeSandboxPort["prepareNativeWorkspace"]>[0]) {
    NativeCommandBindingSchema.parse(input.binding);
    NativeMetadataProtectionSchema.parse(input.metadata);
    if (!/^\/home\/sandbox\/checkouts\/[A-Za-z0-9_.-]+$/.test(input.root) || this.nativeOriginal) throw unavailable();
    const operation = this.runOriginal([helper, "--prepare-workspace"], input);
    this.nativeOriginal = operation;
    let original: NativeCommandOriginal;
    try { original = await operation; }
    finally { if (this.nativeOriginal === operation) this.nativeOriginal = undefined; }
    if (original.exitCode !== 0 || original.stderr !== "") throw unavailable();
    return NativeRootIdentitySchema.parse(JSON.parse(original.stdout));
  }

  private async runOriginal(argv: string[], input: unknown): Promise<NativeCommandOriginal> {
    const container = this.nativeState.container;
    if (!container?.running || typeof container.exec !== "function") throw unavailable();
    const body = encoder.encode(JSON.stringify(input));
    if (body.byteLength > 64 * 1024) throw unavailable();
    const stdin = new ReadableStream({ type: "bytes", start(controller) { controller.enqueue(body); controller.close(); } });
    const process = await container.exec(argv, {
      user: "0:0", cwd: "/", env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
      stdin, stdout: "pipe", stderr: "pipe",
    });
    if (!process.stdout || !process.stderr) throw unavailable();
    // Consume original channels concurrently through EOF, including rejected
    // reads. An observer timeout or a process-status label cannot replace them.
    const settled = await Promise.allSettled([
      readBounded(process.stdout, 12 * 1024 * 1024), readBounded(process.stderr, 4096), process.exitCode,
    ]);
    const [stdout, stderr, exit] = settled;
    if (stdout.status !== "fulfilled" || stderr.status !== "fulfilled" || exit.status !== "fulfilled") throw unavailable();
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
