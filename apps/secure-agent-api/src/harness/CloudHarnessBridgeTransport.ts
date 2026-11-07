import type { Sandbox } from "@cloudflare/sandbox";
import {
  assertCloudHarnessBridgeFrame,
  CLOUD_HARNESS_BRIDGE_LIMITS,
} from "./CloudHarnessBridgeLimits";

const BRIDGE_PORT = 4319;

export type BridgeDisconnectReason =
  | "closed"
  | "aborted"
  | "transport_error"
  | "invalid_frame"
  | "overflow"
  | "consumer_error"
  | "cleanup_error";

export interface CloudHarnessBridgeOptions {
  /** A fresh private bridge credential; never a provider credential. */
  credential: string;
  cleanupOnly?: boolean;
  /** Revalidate the durable lease and frozen binding, including generation. */
  authorize: () => Promise<void>;
  signal: AbortSignal;
  /** Revalidate the per-operation lease/process identity using canonical schemas,
   * correlate commands/ACKs, then await the canonical ingestor. Handshake auth
   * alone is insufficient. No ACK may be emitted for rejected/failed frames.
   */
  receive: (frame: string) => Promise<void>;
  disconnected: (reason: BridgeDisconnectReason) => void | Promise<void>;
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
  private finalDisconnectReason: BridgeDisconnectReason | null = null;

  /** Transport loss/cleanup failure is unknown execution outcome, never quiescence.
   * Remains readable even when the disconnect observer itself fails.
   */
  get disconnectReason(): BridgeDisconnectReason | null {
    return this.finalDisconnectReason;
  }

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
    let socket: WebSocket | null = null;
    let accepted = false;
    try {
      options.signal.throwIfAborted();
      if (!/^[A-Za-z0-9_-]{43,256}$/.test(options.credential)) {
        throw new Error("Invalid private harness bridge credential");
      }
      await options.authorize();
      options.signal.throwIfAborted();
      // Never forward browser headers or URLs to the private control endpoint.
      const response = await sandbox.wsConnect(
        new Request("https://harness.internal/bridge", {
          headers: {
            Upgrade: "websocket",
            Connection: "Upgrade",
            Authorization: `Bearer ${options.credential}`,
            "X-Legion-Harness-Intent": options.cleanupOnly
              ? "cleanup"
              : "active",
          },
        }),
        BRIDGE_PORT,
      );
      socket = response.webSocket;
      if (response.status !== 101 || !socket) {
        await response.body?.cancel();
        throw new Error("Private harness bridge upgrade failed");
      }
      // The binding may have been revoked or replaced during the handshake.
      await options.authorize();
      options.signal.throwIfAborted();
      socket.accept();
      accepted = true;
      return new CloudHarnessBridgeTransport(socket, options);
    } catch {
      if (socket) {
        try {
          if (!accepted) socket.accept();
          socket.close(1008, "Private harness bridge handshake failed");
        } catch {
          // Best-effort cleanup must not replace the sanitized public failure.
        }
      }
      // Authorization, abort reasons, SDK errors and response-body failures can
      // contain credentials. Never attach their message, object, stack or cause.
      throw new Error("Private harness bridge handshake failed");
    }
  }

  send(frame: string): void {
    if (this.closed) throw new Error("Private harness bridge is closed");
    assertCloudHarnessBridgeFrame(frame);
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
    if (bytes > CLOUD_HARNESS_BRIDGE_LIMITS.maxFrameBytes) {
      this.finish("invalid_frame");
      return;
    }
    if (
      this.pendingFrames >= CLOUD_HARNESS_BRIDGE_LIMITS.maxPendingFrames ||
      this.pendingBytes + bytes > CLOUD_HARNESS_BRIDGE_LIMITS.maxPendingBytes
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
    // Fence sends and queued delivery before invoking any fallible cleanup code.
    this.closed = true;
    this.finalDisconnectReason = reason;
    const cleanup = (action: () => void): void => {
      try {
        action();
      } catch {
        // Record only a fixed category. Never expose cleanup messages or causes.
        this.finalDisconnectReason = "cleanup_error";
      }
    };
    cleanup(() => this.socket.removeEventListener("message", this.onMessage));
    cleanup(() => this.socket.removeEventListener("close", this.onClose));
    cleanup(() => this.socket.removeEventListener("error", this.onError));
    cleanup(() =>
      this.options.signal.removeEventListener("abort", this.onAbort),
    );
    cleanup(() =>
      this.socket.close(
        reason === "closed" || reason === "aborted" ? 1000 : 1008,
        "Private harness bridge disconnected",
      ),
    );
    cleanup(() => {
      // A failed observer cannot replace send's sanitized error or reject the
      // receive queue. Preserve a fenced, inspectable failure category instead.
      void Promise.resolve(
        this.options.disconnected(this.finalDisconnectReason ?? reason),
      ).catch(() => {
        this.finalDisconnectReason = "cleanup_error";
      });
    });
  }
}
