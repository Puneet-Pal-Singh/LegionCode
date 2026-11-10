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
  private openingIntent: string | null = null;
  private openingPhase: "reserved" | "dispatching" | "acknowledged" | "cancelled_before_dispatch" | null = null;
  private readonly openingDeliveries = new Set<string>();
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
      const transport = this.transport, committer = this.openingCommitter;
      if (!committer || !transport) throw new Error("Opening commit authority unavailable");
      const captured = CloudHarnessHostFrameSchema.parse(frame);
      if (captured.type !== "opening_claim" && captured.type !== "opening_session") throw new Error("Opening frame mismatch");
      const intent = JSON.stringify(captured.intent);
      const phase = captured.type === "opening_session" ? "acknowledged" : captured.operation === "reserve" ? "reserved" : captured.operation === "cancel_before_dispatch" ? "cancelled_before_dispatch" : "dispatching";
      if (this.openingDeliveries.size >= 3 || this.openingDeliveries.has(captured.deliveryId) ||
          (phase === "reserved" ? this.openingIntent !== null || this.openingPhase !== null :
            this.openingIntent !== intent || this.openingPhase !== (phase === "dispatching" || phase === "cancelled_before_dispatch" ? "reserved" : "dispatching")))
        throw new Error("Opening delivery correlation mismatch");
      if (captured.type === "opening_session" && (captured.session.runAttemptId !== captured.intent.runAttemptId ||
          captured.session.instanceId !== captured.intent.instanceId || captured.session.processGeneration !== captured.intent.processGeneration))
        throw new Error("Opening native identity mismatch");
      this.openingDeliveries.add(captured.deliveryId);
      const assertCurrent = () => {
        if (this.closed || this.transport !== transport || this.openingCommitter !== committer)
          throw new Error("Opening transport changed or closed");
      };
      // Late learned identity is cleanup data; the exact-intent durable CAS
      // remains authoritative after provider authorization has been revoked.
      if (captured.type === "opening_claim" && captured.operation !== "cancel_before_dispatch") {
        await this.supervisor.authorize(this.target);
        assertCurrent();
      }
      // Give the callback its own parsed copy; retain the original full intent
      // and session for correlation across the asynchronous database commit.
      const callbackFrame = CloudHarnessHostFrameSchema.parse(captured);
      if (callbackFrame.type !== "opening_claim" && callbackFrame.type !== "opening_session") throw new Error("Opening frame mismatch");
      const commit = await committer(callbackFrame);
      assertCurrent();
      if (commit.openingRef !== captured.intent.openingRef || commit.commandFingerprint !== captured.intent.commandFingerprint ||
          commit.processGeneration !== captured.intent.processGeneration || commit.phase !== phase)
        throw new Error("Opening commit identity mismatch");
      this.openingIntent = intent;
      this.openingPhase = phase;
      transport.send(encodeCloudHarnessBridgeFrame({type: "opening_commit", deliveryId: captured.deliveryId, commit}));
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
