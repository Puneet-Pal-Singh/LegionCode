import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  HarnessCommitAckSchema,
  HarnessObservationSchema,
  type HarnessCommitAck,
  type HarnessObservation,
  type HarnessSession,
  type HarnessStartCommand,
} from "@repo/worker-protocol";
import {
  CloudHarnessWorkerFrameSchema,
  CloudHarnessResultSchema,
  sameCloudHarnessSession,
  cloudHarnessRequestTarget,
  isCloudHarnessCleanup,
  type CloudHarnessRequest,
} from "../src/harness/CloudHarnessBridgeProtocol";
import {
  CLOUD_HARNESS_BRIDGE_LIMITS,
  encodeCloudHarnessBridgeFrame,
} from "../src/harness/CloudHarnessBridgeLimits";
import {
  assertCloudHarnessLaunchAvailable,
  CloudHarnessUnavailableError,
} from "../src/harness/CloudHarnessAvailability";
import type { CloudHarnessComposition } from "./composition";
/** Connection-local delivery/correlation only. Core owns the durable bounded
 * unacknowledged journal, session attachment, and single-use native replies.
 */
export function attachCloudHarnessBridge(
  socket: WebSocket,
  composition: CloudHarnessComposition,
  admission: HarnessStartCommand,
  cleanupOnly = false,
  cleanupSession?: HarnessSession,
): void {
  const admittedCommand = JSON.stringify(admission);
  const assertSessionScope = (session: HarnessSession): void => {
    if (
      cleanupOnly &&
      (!cleanupSession || !sameCloudHarnessSession(session, cleanupSession))
    )
      throw new Error("Cloud harness cleanup process mismatch");
    if (
      session.runAttemptId !== admission.selection.runAttemptId ||
      session.instanceId !== admission.selection.instanceId
    )
      throw new Error("Cloud harness bridge binding mismatch");
  };
  let closed = false;
  let activeRequests = 0;
  const seenRequests = new Set<string>();
  const waitingAcks = new Map<
    string,
    {
      observation: HarnessObservation;
      resolve: (ack: HarnessCommitAck) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      bytes: number;
      acknowledging?: boolean;
    }
  >();
  let pendingBytes = 0;
  let pendingRequestBytes = 0;
  const fence = () => {
    if (closed) return;
    closed = true;
    for (const pending of waitingAcks.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new Error("Cloud harness delivery interrupted; recovery required"),
      );
    }
    waitingAcks.clear();
    pendingBytes = 0;
    // No lease release, terminal success, prompt retry, or journal pruning here.
    try {
      socket.close(1008, "Cloud harness bridge fenced");
    } catch {
      /* Already fenced. */
    }
  };
  const send = (value: unknown) => {
    const encoded = encodeCloudHarnessBridgeFrame(value);
    if (
      closed ||
      socket.readyState !== 1 ||
      socket.bufferedAmount + Buffer.byteLength(encoded) >
        CLOUD_HARNESS_BRIDGE_LIMITS.maxPendingBytes
    )
      throw new Error("Cloud harness connection unavailable");
    socket.send(encoded, (error) => {
      if (error) fence();
    });
  };
  const observe = async (
    raw: HarnessObservation,
  ): Promise<HarnessCommitAck> => {
    const observation = HarnessObservationSchema.parse(raw);
    assertSessionScope(observation.session);
    await composition.authorize({
      operation: "observation",
      session: observation.session,
    });
    const deliveryId = randomUUID();
    const frame = { type: "observation", deliveryId, observation };
    const bytes = Buffer.byteLength(encodeCloudHarnessBridgeFrame(frame));
    if (
      closed ||
      waitingAcks.size >= CLOUD_HARNESS_BRIDGE_LIMITS.maxPendingFrames ||
      pendingBytes + bytes > CLOUD_HARNESS_BRIDGE_LIMITS.maxPendingBytes
    )
      throw new Error("Cloud harness delivery backpressure; recovery required");
    // Core persisted this observation before invoking this callback.
    return new Promise<HarnessCommitAck>((resolve, reject) => {
      const timer = setTimeout(fence, 60_000);
      waitingAcks.set(deliveryId, {
        observation,
        resolve,
        reject,
        timer,
        bytes,
      });
      pendingBytes += bytes;
      try {
        send(frame);
      } catch {
        fence();
      }
    });
  };
  const dispatch = async (request: CloudHarnessRequest): Promise<void> => {
    const operation = request.operation;
    const target = cloudHarnessRequestTarget(request);
    if (cleanupOnly && !isCloudHarnessCleanup(target))
      throw new Error("Cleanup capability cannot authorize provider work");
    if ("command" in target) {
      if (JSON.stringify(target.command) !== admittedCommand)
        throw new Error("Cloud harness bridge admission mismatch");
    } else assertSessionScope(target.session);
    await composition.authorize(target);
    if (request.operation === "open" && request.command.resumeSession !== null)
      throw new Error(
        "Cloud harness prior-generation resume unavailable; recovery required",
      );
    if (request.operation === "execute") {
      assertSessionScope(request.session);
      await composition.authorize({
        operation: "execute",
        session: request.session,
      });
    }
    // Gate before provider process/session boot, credentials, or external replies.
    if (!isCloudHarnessCleanup(target)) assertCloudHarnessLaunchAvailable();
    const signal = new AbortController().signal;
    let result: unknown;
    switch (request.operation) {
      case "open":
        result = {
          type: "result",
          requestId: request.requestId,
          operation,
          value: await composition.execution.open({
            command: request.command,
            signal,
          }),
        };
        break;
      case "execute":
        await composition.execution.execute({
          command: request.command,
          session: request.session,
          signal,
          observe,
        });
        result = {
          type: "result",
          requestId: request.requestId,
          operation,
          value: null,
        };
        break;
      case "observe":
        await composition.execution.observeExisting({
          session: request.session,
          signal,
          observe,
        });
        result = {
          type: "result",
          requestId: request.requestId,
          operation,
          value: null,
        };
        break;
      case "control":
        result = {
          type: "result",
          requestId: request.requestId,
          operation,
          value: await composition.execution.control(request.command),
        };
        break;
      case "quiescence":
        result = {
          type: "result",
          requestId: request.requestId,
          operation,
          value: await composition.execution.awaitQuiescence({
            session: request.session,
            timeoutMs: request.timeoutMs,
          }),
        };
        break;
    }
    await composition.authorize(target);
    send(CloudHarnessResultSchema.parse(result));
  };
  socket.on("message", (data, binary) => {
    if (closed) return;
    const text = data.toString();
    if (
      binary ||
      Buffer.byteLength(text) > CLOUD_HARNESS_BRIDGE_LIMITS.maxFrameBytes
    ) {
      fence();
      return;
    }
    let frame: ReturnType<typeof CloudHarnessWorkerFrameSchema.parse>;
    try {
      frame = CloudHarnessWorkerFrameSchema.parse(JSON.parse(text));
    } catch {
      fence();
      return;
    }
    if (frame.type === "ack") {
      const ackFrame = frame;
      const pending = waitingAcks.get(ackFrame.deliveryId);
      if (
        !pending ||
        pending.acknowledging ||
        !sameCloudHarnessSession(
          pending.observation.session,
          ackFrame.ack.session,
        ) ||
        pending.observation.sequence !== ackFrame.ack.committedSequence
      ) {
        fence();
        return;
      }
      pending.acknowledging = true;
      void composition
        .authorize({ operation: "commit_ack", session: ackFrame.ack.session })
        .then(() => {
          if (closed || waitingAcks.get(ackFrame.deliveryId) !== pending)
            return;
          waitingAcks.delete(ackFrame.deliveryId);
          pendingBytes -= pending.bytes;
          clearTimeout(pending.timer);
          pending.resolve(HarnessCommitAckSchema.parse(ackFrame.ack));
        })
        .catch(fence);
      return;
    }
    if (
      activeRequests >= 128 ||
      pendingRequestBytes + pendingBytes + Buffer.byteLength(text) >
        CLOUD_HARNESS_BRIDGE_LIMITS.maxPendingBytes ||
      seenRequests.size >= 512 ||
      seenRequests.has(frame.requestId)
    ) {
      fence();
      return;
    }
    // Record BEFORE async dispatch. Lost receipts never cause automatic resend.
    seenRequests.add(frame.requestId);
    activeRequests++;
    const requestBytes = Buffer.byteLength(text);
    pendingRequestBytes += requestBytes;
    const request = frame;
    void dispatch(request)
      .catch((error: unknown) => {
        if (!closed) {
          try {
            send({
              type: "error",
              requestId: request.requestId,
              code:
                error instanceof CloudHarnessUnavailableError
                  ? "unavailable"
                  : "recovery_required",
            });
          } catch {
            fence();
          }
        }
      })
      .finally(() => {
        activeRequests--;
        pendingRequestBytes -= requestBytes;
      });
  });
  socket.on("close", fence);
  socket.on("error", fence);
}
