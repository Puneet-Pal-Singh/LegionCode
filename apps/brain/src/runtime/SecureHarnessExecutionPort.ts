import type { WebSocket } from "@cloudflare/workers-types";
import type { DelegatedHarnessPort } from "@repo/runtime-kernel";
import type {
  HarnessAdmissionSelection,
  ProductMode,
} from "@repo/platform-protocol";
import {
  HARNESS_SERVICE_BRIDGE_PATH,
  HARNESS_SERVICE_CAPABILITY_PATH,
  HarnessServiceCapabilityRequestSchema,
  HarnessServiceCapabilitySchema,
  HarnessServiceConnectSchema,
  HarnessServiceHostFrameSchema,
  HarnessServiceWorkerFrameSchema,
  HarnessServiceRequestSchema, HarnessStartCommandSchema, HarnessOpeningFenceTargetSchema, fingerprintHarnessCommand,
  type HarnessServiceRequest,
  type HarnessServiceResult,
  type HarnessServiceScope,
  type HarnessServiceCapability,
  type HarnessObservation,
  type HarnessCommitAck,
  type HarnessOpeningIntent,
  type HarnessStartCommand,
  type HarnessSession,
} from "@repo/worker-protocol";
import type { SecureExecutionSessionHandle, SecureExecutionSessionPort } from "../services/secure-execution/SecureExecutionSessionClient";
import type { Env } from "../types/ai";

const MAX_FRAME = 16 * 1024 * 1024;
const MAX_PENDING_BYTES = 32 * 1024 * 1024;
/** Worker-safe service-binding proxy; durable observations are ACKed only after
 * the kernel callback commits. Lost/ambiguous commands are never retransmitted. */
export class SecureHarnessExecutionPort implements DelegatedHarnessPort {
  private socket: WebSocket | null = null;
  private executionSession: SecureExecutionSessionPort | null = null;
  private cleanupSession: SecureExecutionSessionHandle | null = null;
  bindCleanupSession(session: SecureExecutionSessionHandle): void {
    if (this.cleanupSession || this.executionSession) throw new Error("Cleanup session already bound");
    this.cleanupSession = Object.freeze({...session, lease: Object.freeze({...session.lease})});
  }
  async fenceOpening(target: import("@repo/worker-protocol").HarnessOpeningFenceTarget, timeoutMs = 5_000) {
    target = HarnessOpeningFenceTargetSchema.parse(target);
    await this.connect(new AbortController().signal);
    try {
      const result = await this.request({type: "request", requestId: crypto.randomUUID(), operation: "opening_fence", target, timeoutMs});
      if (result.operation !== "opening_fence") throw new Error("Opening cleanup correlation mismatch");
      return result.value;
    } finally { this.fence(); }
  }

  private observer:
    | ((observation: HarnessObservation) => Promise<HarnessCommitAck>)
    | null = null;
  private closed = false;
  private queue: Promise<void> = Promise.resolve();
  private pendingBytes = 0;
  private pendingFrames = 0;
  private connected: { resolve(): void; reject(error: Error): void } | null =
    null;
  private readonly pending = new Map<
    string,
    {
      resolve(value: HarnessServiceResult): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    private readonly env: Env,
    private readonly scope: HarnessServiceScope,
  ) {}

  private openingAuthority: {
    reserve(command: HarnessStartCommand, intent: HarnessOpeningIntent): Promise<void>;
    beginDispatch(intent: HarnessOpeningIntent): Promise<void>;
    acknowledge(intent: HarnessOpeningIntent, session: HarnessSession): Promise<void>;
  } | null = null;
  private openingCommand: HarnessStartCommand | null = null;
  private openingFingerprint: string | null = null;
  private openingLease: SecureExecutionSessionHandle["lease"] | null = null;
  bindOpeningAuthority(authority: NonNullable<SecureHarnessExecutionPort["openingAuthority"]>): void {
    if (this.openingAuthority) throw new Error("Opening authority is already bound");
    this.openingAuthority = Object.freeze({reserve: authority.reserve.bind(authority), beginDispatch: authority.beginDispatch.bind(authority), acknowledge: authority.acknowledge.bind(authority)});
  }
  bindExecutionSession(session: SecureExecutionSessionPort): void {
    if (this.executionSession)
      throw new Error("Harness lease authority is already bound");
    this.executionSession = session;
  }
  async capability(
    productMode: ProductMode,
    capture: HarnessAdmissionSelection,
  ): Promise<HarnessServiceCapability> {
    const body = HarnessServiceCapabilityRequestSchema.parse({
      scope: this.scope,
      productMode,
      capture,
    });
    const response = await this.env.SECURE_API.fetch(
      `http://internal${HARNESS_SERVICE_CAPABILITY_PATH}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Runtime-Secret": this.secret(),
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) throw new Error("Harness service capability unavailable");
    return HarnessServiceCapabilitySchema.parse(await response.json());
  }
  async open(input: Parameters<DelegatedHarnessPort["open"]>[0]) {
    if (!this.openingAuthority || this.openingCommand) throw new Error("Durable opening authority unavailable or already used");
    const command = HarnessStartCommandSchema.parse(input.command);
    this.openingCommand = command;
    this.openingFingerprint = await fingerprintHarnessCommand(command);
    await this.connect(input.signal);
    if (!this.executionSession) throw new Error("Opening checkout lease unavailable");
    const { lease } = await this.executionSession.acquire();
    this.openingLease = Object.freeze({...lease});
    const result = await this.request({
      type: "request",
      requestId: crypto.randomUUID(),
      operation: "open",
      executionLease: {kind: "cloud", leaseId: lease.leaseId, sandboxId: lease.sandboxId, generation: lease.generation},
      command,
    });
    if (result.operation !== "open")
      throw new Error("Harness service open correlation mismatch");
    return result.value;
  }
  async execute(
    input: Parameters<DelegatedHarnessPort["execute"]>[0],
  ): Promise<void> {
    this.observer = input.observe;
    await this.runObserved(
      {
        type: "request",
        requestId: crypto.randomUUID(),
        operation: "execute",
        command: input.command,
        session: input.session,
      },
      input.signal,
    );
  }
  async observeExisting(
    input: Parameters<DelegatedHarnessPort["observeExisting"]>[0],
  ): Promise<void> {
    this.observer = input.observe;
    await this.connect(input.signal);
    await this.runObserved(
      {
        type: "request",
        requestId: crypto.randomUUID(),
        operation: "observe",
        session: input.session,
      },
      input.signal,
    );
  }
  async control(command: Parameters<DelegatedHarnessPort["control"]>[0]) {
    const result = await this.request({
      type: "request",
      requestId: crypto.randomUUID(),
      operation: "control",
      command,
    });
    if (result.operation !== "control")
      throw new Error("Harness service control correlation mismatch");
    return result.value;
  }
  async awaitQuiescence(
    input: Parameters<DelegatedHarnessPort["awaitQuiescence"]>[0],
  ) {
    const result = await this.request({
      type: "request",
      requestId: crypto.randomUUID(),
      operation: "quiescence",
      ...input,
    });
    if (result.operation !== "quiescence")
      throw new Error("Harness service quiescence correlation mismatch");
    return result.value;
  }
  private async runObserved(
    request: HarnessServiceRequest,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const abort = () => this.fence();
    signal.addEventListener("abort", abort, { once: true });
    try {
      await this.request(request);
      await this.queue;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  private async connect(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.closed)
      throw new Error("Harness service is fenced; explicit recovery required");
    if (this.socket) return;
    if (!this.executionSession && !this.cleanupSession)
      throw new Error("Harness service requires the canonical checkout lease");
    const owner = this.executionSession;
    const session = this.cleanupSession ?? (owner ? await owner.acquire() : null);
    if (!session) throw new Error("Canonical cleanup checkout unavailable");
    signal.throwIfAborted();
    const response = await this.env.SECURE_API.fetch(
      `http://internal${HARNESS_SERVICE_BRIDGE_PATH}`,
      {
        headers: {
          Upgrade: "websocket",
          Authorization: `Bearer ${session.token}`,
          "X-Internal-Runtime-Secret": this.secret(),
        },
      },
    );
    const socket = response.webSocket;
    if (response.status !== 101 || !socket)
      throw new Error("Harness service bridge unavailable");
    this.socket = socket;
    socket.accept();
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        this.fence();
        return;
      }
      const bytes = new TextEncoder().encode(event.data).byteLength;
      if (
        bytes > MAX_FRAME ||
        this.pendingFrames >= 64 ||
        this.pendingBytes + bytes > MAX_PENDING_BYTES
      ) {
        this.fence();
        return;
      }
      this.pendingFrames++;
      this.pendingBytes += bytes;
      const data = event.data;
      const operation = this.queue
        .then(() => this.receive(data))
        .finally(() => {
          this.pendingFrames--;
          this.pendingBytes -= bytes;
        });
      this.queue = operation;
      void operation.catch(() => this.fence());
    });
    socket.addEventListener("close", () => this.fence());
    socket.addEventListener("error", () => this.fence());
    const ready = new Promise<void>((resolve, reject) => {
      this.connected = { resolve, reject };
    });
    const timer = setTimeout(() => this.fence(), 30_000);
    const abort = () => this.fence();
    signal.addEventListener("abort", abort, { once: true });
    try {
      this.send(
        HarnessServiceConnectSchema.parse({
          type: "connect",
          scope: this.scope,
          lease: {
            leaseId: session.lease.leaseId,
            generation: session.lease.generation,
            sandboxId: session.lease.sandboxId,
          },
        }),
      );
      await ready;
      signal.throwIfAborted();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
  private request(input: HarnessServiceRequest): Promise<HarnessServiceResult> {
    const request = HarnessServiceRequestSchema.parse(input);
    if (this.closed || !this.socket || this.pending.size >= 64)
      return Promise.reject(
        new Error("Harness service unavailable; recovery required"),
      );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fence(), 60_000);
      this.pending.set(request.requestId, { resolve, reject, timer });
      try {
        this.send(request);
      } catch {
        this.fence();
      }
    });
  }
  private async receive(data: string): Promise<void> {
    const frame = HarnessServiceHostFrameSchema.parse(JSON.parse(data));
    if (frame.type === "connected") {
      if (!this.connected) throw new Error("Unexpected service handshake");
      this.connected.resolve();
      this.connected = null;
      return;
    }
    if (frame.type === "opening_claim" || frame.type === "opening_session") {
      const authority = this.openingAuthority, command = this.openingCommand;
      if (!authority || !command || !this.executionSession) throw new Error("Opening has no canonical authority");
      const intent = frame.intent;
      if (intent.commandFingerprint !== this.openingFingerprint || intent.commandId !== command.commandId ||
          intent.runAttemptId !== command.selection.runAttemptId || intent.instanceId !== command.selection.instanceId ||
          intent.authOwnerGeneration !== command.selection.authOwnerGeneration || intent.workspaceGrantId !== command.selection.workspaceGrantId ||
          intent.checkoutLeaseId !== command.leaseId || intent.startSnapshotId !== command.startSnapshot.snapshotKey ||
          intent.openingRef !== `${command.selection.runAttemptId}:${intent.processGeneration}`)
        throw new Error("Opening differs from captured canonical command");
      const lease = this.openingLease;
      if (!lease) throw new Error("Opening has no retained checkout identity");
      if (intent.executionLease.kind !== "cloud" || intent.executionLease.leaseId !== lease.leaseId ||
          intent.executionLease.sandboxId !== lease.sandboxId || intent.executionLease.generation !== lease.generation)
        throw new Error("Opening checkout lease mismatch");
      if (frame.type === "opening_session") await authority.acknowledge(intent, frame.session);
      else if (frame.operation === "reserve") await authority.reserve(command, intent);
      else await authority.beginDispatch(intent);
      // Each adapter promise resolves only AFTER its canonical database COMMIT.
      this.send({ type: "opening_commit", deliveryId: frame.deliveryId, commit: {
        openingRef: intent.openingRef, commandFingerprint: intent.commandFingerprint,
        processGeneration: intent.processGeneration,
        phase: frame.type === "opening_session" ? "acknowledged" : frame.operation === "reserve" ? "reserved" : "dispatching",
      } });
      return;
    }
    if (frame.type === "observation") {
      if (!this.observer)
        throw new Error("Harness observation has no canonical owner");
      const ack = await this.observer(frame.observation);
      this.send({ type: "ack", deliveryId: frame.deliveryId, ack });
      return;
    }
    const pending = this.pending.get(frame.requestId);
    if (!pending)
      throw new Error("Unknown harness service request correlation");
    this.pending.delete(frame.requestId);
    clearTimeout(pending.timer);
    if (frame.type === "error") {
      pending.reject(new Error(`Harness service ${frame.code}`));
      this.fence();
      return;
    }
    pending.resolve(frame);
  }
  private send(input: unknown): void {
    const data = JSON.stringify(HarnessServiceWorkerFrameSchema.parse(input));
    if (
      new TextEncoder().encode(data).byteLength > MAX_FRAME ||
      !this.socket ||
      this.closed
    )
      throw new Error("Harness service frame unavailable");
    this.socket.send(data);
  }
  private fence(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new Error(
      "Harness service transport lost; canonical recovery required",
    );
    this.connected?.reject(error);
    this.connected = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    try {
      this.socket?.close(1011, "recovery required");
    } catch {
      /* Already closed. */
    }
  }
  private secret(): string {
    if (!this.env.INTERNAL_RUNTIME_EVENT_SECRET)
      throw new Error("Harness service authentication unavailable");
    return this.env.INTERNAL_RUNTIME_EVENT_SECRET;
  }
}
