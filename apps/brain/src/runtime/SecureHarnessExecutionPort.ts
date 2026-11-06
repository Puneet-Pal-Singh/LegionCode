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
  HarnessServiceRequestSchema,
  type HarnessServiceRequest,
  type HarnessServiceResult,
  type HarnessServiceScope,
  type HarnessServiceCapability,
  type HarnessObservation,
  type HarnessCommitAck,
} from "@repo/worker-protocol";
import type { SecureExecutionSessionPort } from "../services/secure-execution/SecureExecutionSessionClient";
import type { Env } from "../types/ai";

const MAX_FRAME = 16 * 1024 * 1024;
const MAX_PENDING_BYTES = 32 * 1024 * 1024;
/** Worker-safe service-binding proxy; durable observations are ACKed only after
 * the kernel callback commits. Lost/ambiguous commands are never retransmitted. */
export class SecureHarnessExecutionPort implements DelegatedHarnessPort {
  private socket: WebSocket | null = null;
  private executionSession: SecureExecutionSessionPort | null = null;
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
    await this.connect(input.signal);
    const result = await this.request({
      type: "request",
      requestId: crypto.randomUUID(),
      operation: "open",
      command: input.command,
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
    if (!this.executionSession)
      throw new Error("Harness service requires the canonical checkout lease");
    const session = await this.executionSession.acquire();
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
