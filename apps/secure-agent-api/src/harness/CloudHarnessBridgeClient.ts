import {
  HarnessCommitAckSchema,
  HarnessObservationSchema,
  type HarnessCommitAck,
  type HarnessObservation,
  type HarnessSession,
  type HarnessOpeningCommit,
} from "@repo/worker-protocol";
import {
  CloudHarnessHostFrameSchema,
  cloudHarnessRequestTarget,
  CloudHarnessRequestSchema,
  sameCloudHarnessSession,
  type CloudHarnessHostFrame,
  type CloudHarnessRequest,
} from "./CloudHarnessBridgeProtocol";
import {
  CLOUD_HARNESS_BRIDGE_LIMITS,
  encodeCloudHarnessBridgeFrame,
} from "./CloudHarnessBridgeLimits";
import type { CloudHarnessBridgeTransport } from "./CloudHarnessBridgeTransport";
import {
  CloudHarnessSupervisor,
  type CloudHarnessTarget,
} from "./CloudHarnessSupervisor";
type Observe = (observation: HarnessObservation) => Promise<HarnessCommitAck>;
type Result = Extract<CloudHarnessHostFrame, { type: "result" }>;

export type CloudOpeningFrame = Extract<CloudHarnessHostFrame, {type: "opening_claim" | "opening_session"}>;
export type CloudOpeningCommitter = (frame: CloudOpeningFrame) => Promise<HarnessOpeningCommit>;
export class CloudHarnessBridgeClient {
  private openingCommitter: CloudOpeningCommitter | null = null;
  bindOpeningCommitter(committer: CloudOpeningCommitter): void {
    if (this.openingCommitter) throw new Error("Opening committer cannot be replaced");
    this.openingCommitter = committer;
  }

  private transport?: CloudHarnessBridgeTransport;
  private readonly pending = new Map<
    string,
    {
      operation: CloudHarnessRequest["operation"];
      resolve: (result: Result) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      bytes: number;
      target: CloudHarnessTarget;
    }
  >();
  private observer?: { session: HarnessSession; observe: Observe };
  private closed = false;
  private pendingBytes = 0;
  get isClosed(): boolean {
    return this.closed;
  }

  constructor(
    private readonly supervisor: CloudHarnessSupervisor,
    private readonly target: CloudHarnessTarget,
    private readonly timeoutMs: number,
  ) {}

  async connect(signal: AbortSignal): Promise<void> {
    this.transport = await this.supervisor.connect(this.target, {
      signal,
      receive: (frame) => this.receive(frame),
      disconnected: () => this.fence(),
    });
  }

  setObserver(session: HarnessSession, observe: Observe): void {
    if (
      this.observer &&
      !sameCloudHarnessSession(this.observer.session, session)
    )
      throw new Error("Cloud harness binding mismatch");
    this.observer = { session, observe };
  }

  async request(
    raw: CloudHarnessRequest,
    beforeSend?: () => void,
  ): Promise<Result> {
    const request = CloudHarnessRequestSchema.parse(raw);
    const encoded = encodeCloudHarnessBridgeFrame(request);
    const bytes = new TextEncoder().encode(encoded).byteLength;
    const target = cloudHarnessRequestTarget(request);
    await this.supervisor.authorize(target);
    if (
      this.closed ||
      !this.transport ||
      this.pending.size >= 128 ||
      this.pendingBytes + bytes > CLOUD_HARNESS_BRIDGE_LIMITS.maxPendingBytes
    )
      throw new Error("Cloud harness transport unavailable; recovery required");
    beforeSend?.();
    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => this.fence(), this.timeoutMs);
      this.pending.set(request.requestId, {
        operation: request.operation,
        resolve,
        reject,
        timer,
        bytes,
        target,
      });
      this.pendingBytes += bytes;
      try {
        this.transport!.send(encoded);
      } catch {
        this.fence();
      }
    });
  }

  private async receive(encoded: string): Promise<void> {
    const frame = CloudHarnessHostFrameSchema.parse(JSON.parse(encoded));
    if (this.closed) throw new Error("Cloud harness transport fenced");
    if (frame.type === "opening_claim" || frame.type === "opening_session") {
      if (!this.openingCommitter || !this.transport) throw new Error("Opening commit authority unavailable");
      // A late learned identity is cleanup data: PG's exact-intent CAS remains
      // authoritative even after provider authorization is revoked.
      if (frame.type === "opening_claim") await this.supervisor.authorize(this.target);
      const commit = await this.openingCommitter(frame);
      if (this.closed || commit.openingRef !== frame.intent.openingRef || commit.commandFingerprint !== frame.intent.commandFingerprint ||
          commit.processGeneration !== frame.intent.processGeneration || commit.phase !== (frame.type === "opening_session" ? "acknowledged" : frame.operation === "reserve" ? "reserved" : "dispatching"))
        throw new Error("Opening commit identity mismatch");
      this.transport.send(encodeCloudHarnessBridgeFrame({type: "opening_commit", deliveryId: frame.deliveryId, commit}));
      return;
    }
    if (frame.type === "observation") {
      const observation = HarnessObservationSchema.parse(frame.observation);
      const observer = this.observer;
      if (
        !observer ||
        !sameCloudHarnessSession(observer.session, observation.session)
      )
        throw new Error("Cloud harness observation binding mismatch");
      await this.supervisor.authorize({
        operation: "observation",
        session: observation.session,
      });
      const ack = HarnessCommitAckSchema.parse(
        await observer.observe(observation),
      );
      if (
        !sameCloudHarnessSession(ack.session, observation.session) ||
        ack.committedSequence !== observation.sequence
      )
        throw new Error("Cloud harness commit acknowledgement mismatch");
      await this.supervisor.authorize({
        operation: "commit_ack",
        session: observation.session,
      });
      if (this.closed) throw new Error("Cloud harness transport fenced");
      // Only the canonical durable commit callback can produce this ACK.
      this.transport!.send(
        encodeCloudHarnessBridgeFrame({
          type: "ack",
          deliveryId: frame.deliveryId,
          ack,
        }),
      );
      return;
    }
    const pending = this.pending.get(frame.requestId);
    if (
      !pending ||
      (frame.type === "result" && frame.operation !== pending.operation)
    )
      throw new Error("Cloud harness response correlation mismatch");
    await this.supervisor.authorize(pending.target);
    this.pending.delete(frame.requestId);
    this.pendingBytes -= pending.bytes;
    clearTimeout(pending.timer);
    if (frame.type === "error")
      pending.reject(
        new Error(`Cloud harness ${frame.code}; recovery required`),
      );
    else pending.resolve(frame);
  }

  fence(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new Error("Cloud harness outcome unknown; recovery required"),
      );
    }
    this.pending.clear();
    this.pendingBytes = 0;
    this.transport?.close();
  }
}
