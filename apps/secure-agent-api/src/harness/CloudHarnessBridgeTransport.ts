import type { Sandbox } from "@cloudflare/sandbox";

const BRIDGE_PORT = 4319;
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_PENDING_BYTES = 1024 * 1024;
const MAX_PENDING_FRAMES = 64;

export type BridgeDisconnectReason =
  | "closed"
  | "aborted"
  | "transport_error"
  | "invalid_frame"
  | "overflow"
  | "consumer_error";

export interface CloudHarnessBridgeOptions {
  /** A fresh private bridge credential; never a provider credential. */
  credential: string;
  /** Revalidate the durable lease and frozen binding, including generation. */
  authorize: () => Promise<void>;
  signal: AbortSignal;
  /** Parse canonical worker-protocol frames and await the canonical ingestor here. */
  receive: (frame: string) => Promise<void>;
  disconnected: (reason: BridgeDisconnectReason) => void;
}

/**
 * Worker-only private byte transport. It does not acknowledge observations,
 * retry commands, decide completion, release leases, or own a delivery journal.
 */
export class CloudHarnessBridgeTransport {
  private pendingBytes = 0;
  private pendingFrames = 0;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(
    private readonly socket: WebSocket,
    private readonly options: CloudHarnessBridgeOptions,
  ) {
    socket.addEventListener("message", this.onMessage);
    socket.addEventListener("close", this.onClose);
    socket.addEventListener("error", this.onError);
    options.signal.addEventListener("abort", this.onAbort, { once: true });
  }

  static async connect(
    sandbox: Pick<Sandbox, "wsConnect">,
    options: CloudHarnessBridgeOptions,
  ): Promise<CloudHarnessBridgeTransport> {
    options.signal.throwIfAborted();
    if (!/^[A-Za-z0-9_-]{43,256}$/.test(options.credential)) {
      throw new Error("Invalid private harness bridge credential");
    }
    await options.authorize();
    options.signal.throwIfAborted();
    // Construct a private request rather than forwarding browser headers/URL.
    // wsConnect is provided by getSandbox(), not the Sandbox DO class itself.
    const response = await sandbox.wsConnect(
      new Request("https://harness.internal/bridge", {
        headers: {
          Upgrade: "websocket",
          Connection: "Upgrade",
          Authorization: `Bearer ${options.credential}`,
        },
      }),
      BRIDGE_PORT,
    );
    const socket = response.webSocket;
    if (response.status !== 101 || !socket) {
      await response.body?.cancel();
      throw new Error("Private harness bridge upgrade failed");
    }
    try {
      // The binding may have been revoked or replaced during the handshake.
      await options.authorize();
      options.signal.throwIfAborted();
      const transport = new CloudHarnessBridgeTransport(socket, options);
      socket.accept();
      return transport;
    } catch (error) {
      socket.accept();
      socket.close(1008, "Bridge authorization expired");
      throw error;
    }
  }

  send(frame: string): void {
    if (this.closed) throw new Error("Private harness bridge is closed");
    if (new TextEncoder().encode(frame).byteLength > MAX_FRAME_BYTES) {
      throw new Error("Private harness bridge frame exceeds the size limit");
    }
    try {
      this.socket.send(frame);
    } catch {
      this.finish("transport_error");
      throw new Error("Private harness bridge send failed");
    }
  }

  close(): void {
    this.finish("closed");
  }

  private readonly onMessage = (event: MessageEvent): void => {
    if (this.closed) return;
    if (typeof event.data !== "string") {
      this.finish("invalid_frame");
      return;
    }
    const frame = event.data;
    const bytes = new TextEncoder().encode(frame).byteLength;
    if (bytes > MAX_FRAME_BYTES) {
      this.finish("invalid_frame");
      return;
    }
    if (
      this.pendingFrames >= MAX_PENDING_FRAMES ||
      this.pendingBytes + bytes > MAX_PENDING_BYTES
    ) {
      // Leave uncommitted observations in the host journal for reconciliation.
      this.finish("overflow");
      return;
    }
    this.pendingFrames++;
    this.pendingBytes += bytes;
    this.tail = this.tail.then(async () => {
      try {
        if (!this.closed) await this.options.receive(frame);
      } catch {
        this.finish("consumer_error");
      } finally {
        this.pendingFrames--;
        this.pendingBytes -= bytes;
      }
    });
  };

  private readonly onClose = (): void => this.finish("closed");
  private readonly onError = (): void => this.finish("transport_error");
  private readonly onAbort = (): void => this.finish("aborted");

  private finish(reason: BridgeDisconnectReason): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.removeEventListener("message", this.onMessage);
    this.socket.removeEventListener("close", this.onClose);
    this.socket.removeEventListener("error", this.onError);
    this.options.signal.removeEventListener("abort", this.onAbort);
    try {
      this.socket.close(
        reason === "closed" || reason === "aborted" ? 1000 : 1008,
        "Private harness bridge disconnected",
      );
    } finally {
      this.options.disconnected(reason);
    }
  }
}
