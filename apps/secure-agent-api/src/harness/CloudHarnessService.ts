import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import {
  HarnessServiceCapabilityRequestSchema,
  HarnessServiceCapabilitySchema,
  HarnessServiceConnectSchema,
  HarnessServiceWorkerFrameSchema,
  HarnessServiceHostFrameSchema,
  HarnessServiceResultSchema,
  type HarnessServiceRequest,
  type HarnessOpeningCommit,
  type HarnessOpeningIntent,
} from "@repo/worker-protocol";
import { SessionCreateResponseSchema } from "../schemas/http-api";
import { composeCloudHarnessRuntime } from "../factories/RuntimeCompositionFactory";
import {
  cloudHarnessRequestTarget,
  isCloudHarnessCleanup,
  sameCloudHarnessSession,
} from "./CloudHarnessBridgeProtocol";
import {
  assertCloudHarnessLaunchAvailable,
  CLOUD_HARNESS_AVAILABILITY,
} from "./CloudHarnessAvailability";
import {
  CLOUD_HARNESS_BRIDGE_LIMITS,
  encodeCloudHarnessBridgeFrame,
} from "./CloudHarnessBridgeLimits";

interface LeaseRecord {
  lease: unknown;
  token: string;
}
interface CloudHarnessServiceEnvironment {
  Sandbox: DurableObjectNamespace<Sandbox>;
  AGENT_RUNTIME: {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): {
      getHarnessExecutionSession(lease: {
        leaseId: string;
        sandboxId: string;
        generation: number;
      }): Promise<LeaseRecord | null>;
    };
  };
}
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
async function readBody(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("Invalid harness service request");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > CLOUD_HARNESS_BRIDGE_LIMITS.maxFrameBytes)
        throw new Error("Harness request exceeds limit");
      chunks.push(part.value);
    }
  } catch {
    try {
      await reader.cancel();
    } catch {}
    throw new Error("Invalid harness service request");
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(all));
}

/** Existing internal-service authentication MUST run before either handler. */
export async function handleCloudHarnessCapability(
  request: Request,
): Promise<Response> {
  try {
    HarnessServiceCapabilityRequestSchema.parse(await readBody(request));
  } catch {
    return Response.json({ code: "invalid_request" }, { status: 400 });
  }
  return Response.json(
    HarnessServiceCapabilitySchema.parse({
      available: false,
      code: CLOUD_HARNESS_AVAILABILITY.code,
    }),
  );
}

/** Real SECURE_API Fetcher WebSocket endpoint. No cross-Worker JS factory. */
export function handleCloudHarnessBridge(
  request: Request,
  env: CloudHarnessServiceEnvironment,
): Response {
  const bearer = request.headers
    .get("Authorization")
    ?.match(/^Bearer (.+)$/)?.[1];
  if (!bearer || request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
    return Response.json({ code: "unauthorized" }, { status: 401 });
  const pair = new WebSocketPair();
  const client = pair[0];
  const capturedServer = pair[1];
  if (!client || !capturedServer)
    return Response.json({ code: "unavailable" }, { status: 503 });
  const server = capturedServer;
  let closed = false;
  let activeRequests = 0;
  let pendingBytes = 0;
  const seen = new Set<string>();
  const openingCommits = new Map<string, {intent: HarnessOpeningIntent; phase: HarnessOpeningCommit["phase"];
    connection: ReturnType<typeof HarnessServiceConnectSchema.parse>; acknowledging: boolean;
    bytes: number; resolve(commit: HarnessOpeningCommit): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>}>();
  let openingBytes = 0;
  let connection:
    | ReturnType<typeof HarnessServiceConnectSchema.parse>
    | undefined;
  let connecting = false;
  let ready = false;
  const timer = setTimeout(() => fence(), 10_000);
  const fence = () => {
    if (closed) return;
    closed = true;
    for (const pending of openingCommits.values()) { clearTimeout(pending.timer); pending.reject(new Error("Opening commit outcome unknown")); }
    openingCommits.clear(); openingBytes = 0;
    clearTimeout(timer);
    try {
      server.close(1008, "Harness service recovery required");
    } catch {}
  };
  const send = (value: unknown) => {
    if (closed) throw new Error("Harness service fenced");
    server.send(
      encodeCloudHarnessBridgeFrame(HarnessServiceHostFrameSchema.parse(value)),
    );
  };
  const verify = async () => {
    const capturedConnection = connection;
    if (closed || !capturedConnection)
      throw new Error("Harness service handshake required");
    const scope = capturedConnection.scope;
    const stub = env.AGENT_RUNTIME.get(
      env.AGENT_RUNTIME.idFromName(scope.sessionId),
    );
    const record = await stub.getHarnessExecutionSession(capturedConnection.lease);
    if (closed || connection !== capturedConnection || !record)
      throw new Error("Harness checkout lease unavailable");
    const lease = SessionCreateResponseSchema.shape.lease.parse(record.lease);
    const a = new TextEncoder().encode(bearer),
      b = new TextEncoder().encode(record.token);
    let diff = a.length ^ b.length;
    for (let i = 0; i < Math.max(a.length, b.length); i++)
      diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
    if (
      diff ||
      lease.leaseId !== capturedConnection.lease.leaseId ||
      lease.sandboxId !== capturedConnection.lease.sandboxId ||
      lease.generation !== capturedConnection.lease.generation ||
      lease.workspaceScope.runId !== scope.runId ||
      lease.workspaceScope.workspaceId !== scope.workspaceId ||
      lease.workspaceScope.threadId !== scope.threadId ||
      lease.workspaceScope.turnId !== scope.turnId ||
      lease.workspaceScope.runAttemptId !== scope.runAttemptId
    )
      throw new Error("Harness checkout ownership mismatch");
    // Cleanup remains lease/process scoped even after provider auth revocation.
    // Missing/replaced leases never create/borrow a replacement checkout.
    return { record, lease, scope };
  };
  const dispatch = async (operation: HarnessServiceRequest) => {
    const target = cloudHarnessRequestTarget(operation);
    const { scope } = await verify();
    if (!isCloudHarnessCleanup(target)) assertCloudHarnessLaunchAvailable();
    if (target.operation === "opening_fence") {
      const opening = target.opening, current = await verify();
      if (opening.runAttemptId !== scope.runAttemptId || opening.turnId !== scope.turnId ||
          opening.userId !== scope.userId || opening.workspaceId !== scope.workspaceId || opening.executionLease.kind !== "cloud" ||
          opening.executionLease.leaseId !== current.lease.leaseId || opening.executionLease.sandboxId !== current.lease.sandboxId ||
          opening.executionLease.generation !== current.lease.generation) throw new Error("Opening cleanup scope mismatch");
    } else if ("session" in target && target.session.runAttemptId !== scope.runAttemptId)
      throw new Error("Harness cleanup scope mismatch");
    const { record } = await verify();
    // The trusted Node host binds its cleanup-only grant to this existing
    // checkout bearer plus the exact external session/process generation. No
    // provider credential or new credential authority is introduced here.
    const cleanupSecret = record.token;
    const { execution: port } = composeCloudHarnessRuntime(
      {
        assertActive: async () => assertCloudHarnessLaunchAvailable(),
        assertCleanup: async (requested) => {
          if (requested.operation === "opening_fence") {
            if (target.operation !== "opening_fence" || JSON.stringify(requested.opening) !== JSON.stringify(target.opening))
              throw new Error("Opening cleanup generation mismatch");
          } else if (!("session" in target) || !sameCloudHarnessSession(requested.session, target.session))
            throw new Error("Harness cleanup generation mismatch");
          await verify();
        },
        sandbox: async () => {
          const { lease } = await verify();
          return getSandbox(env.Sandbox, lease.sandboxId);
        },
        bridgeCredential: async () => {
          throw new Error("Harness provider work unavailable");
        },
        cleanupBridgeCredential: async () => {
          await verify();
          return cleanupSecret;
        },
      },
      65_000,
    );
    if (operation.operation === "open") {
      const current = await verify();
      if (operation.executionLease.leaseId !== current.lease.leaseId || operation.executionLease.sandboxId !== current.lease.sandboxId ||
          operation.executionLease.generation !== current.lease.generation) throw new Error("Opening checkout mismatch");
      const openingConnection = connection;
      if (!openingConnection) throw new Error("Opening connection unavailable");
      let committedIntent: string | null = null;
      let committedPhase: HarnessOpeningCommit["phase"] | null = null;
      const deliveries = new Set<string>();
      port.bindOpeningAuthority({ executionLease: operation.executionLease, commit: async (rawFrame) => {
        const frame = HarnessServiceHostFrameSchema.parse(rawFrame);
        if (frame.type !== "opening_claim" && frame.type !== "opening_session") throw new Error("Opening frame mismatch");
        const phase = frame.type === "opening_session" ? "acknowledged" : frame.operation === "reserve" ? "reserved" : frame.operation === "cancel_before_dispatch" ? "cancelled_before_dispatch" : "dispatching";
        const intent = JSON.stringify(frame.intent);
        const assertCurrent = () => {
          if (closed || connection !== openingConnection || server.readyState !== 1)
            throw new Error("Opening connection changed or closed");
        };
        assertCurrent();
        if (deliveries.size >= 3 || deliveries.has(frame.deliveryId) ||
            (phase === "reserved" ? committedIntent !== null || committedPhase !== null :
              committedIntent !== intent || committedPhase !== (phase === "dispatching" || phase === "cancelled_before_dispatch" ? "reserved" : "dispatching")))
          throw new Error("Opening delivery phase mismatch");
        if (frame.type === "opening_session" && (frame.session.runAttemptId !== frame.intent.runAttemptId ||
            frame.session.instanceId !== frame.intent.instanceId || frame.session.processGeneration !== frame.intent.processGeneration))
          throw new Error("Opening session identity mismatch");
        deliveries.add(frame.deliveryId);
        await verify();
        assertCurrent();
        if (frame.intent.executionLease.kind !== "cloud" || JSON.stringify(frame.intent.executionLease) !== JSON.stringify(operation.executionLease))
          throw new Error("Opening host lease mismatch");
        const frameBytes = bytes(encodeCloudHarnessBridgeFrame(frame));
        if (openingCommits.size >= 3 || openingCommits.has(frame.deliveryId) || openingBytes + pendingBytes + frameBytes > CLOUD_HARNESS_BRIDGE_LIMITS.maxPendingBytes)
          throw new Error("Opening commit capacity exceeded");
        const commit = await new Promise<HarnessOpeningCommit>((resolve, reject) => {
          const timer = setTimeout(fence, 60_000);
          openingCommits.set(frame.deliveryId, {intent: frame.intent, phase, connection: openingConnection,
            acknowledging: false, bytes: frameBytes, resolve, reject, timer});
          openingBytes += frameBytes;
          try { send(frame); } catch { fence(); }
        });
        assertCurrent();
        committedIntent = intent; committedPhase = phase;
        return commit;
      } });
      const value = await port.open({command: operation.command, signal: new AbortController().signal});
      await verify();
      send(HarnessServiceResultSchema.parse({type: "result", requestId: operation.requestId, operation: "open", value}));
    } else if (operation.operation === "opening_fence") {
      const value = await port.fenceOpening({target: operation.target, timeoutMs: operation.timeoutMs});
      await verify();
      send(HarnessServiceResultSchema.parse({type: "result", requestId: operation.requestId, operation: "opening_fence", value}));
    } else if (
      operation.operation === "control" &&
      (operation.command.kind === "interrupt" ||
        operation.command.kind === "dispose")
    ) {
      const value = await port.control(operation.command);
      await verify();
      send(
        HarnessServiceResultSchema.parse({
          type: "result",
          requestId: operation.requestId,
          operation: "control",
          value,
        }),
      );
    } else if (operation.operation === "quiescence") {
      const value = await port.awaitQuiescence({
        session: operation.session,
        timeoutMs: operation.timeoutMs,
      });
      await verify();
      send(
        HarnessServiceResultSchema.parse({
          type: "result",
          requestId: operation.requestId,
          operation: "quiescence",
          value,
        }),
      );
    }
  };
  server.addEventListener("message", (event) => {
    if (closed) return;
    if (
      typeof event.data !== "string" ||
      bytes(event.data) > CLOUD_HARNESS_BRIDGE_LIMITS.maxFrameBytes
    ) {
      fence();
      return;
    }
    let frame: ReturnType<typeof HarnessServiceWorkerFrameSchema.parse>;
    try {
      frame = HarnessServiceWorkerFrameSchema.parse(JSON.parse(event.data));
    } catch {
      fence();
      return;
    }
    if (!connection) {
      if (connecting || frame.type !== "connect") {
        fence();
        return;
      }
      connecting = true;
      connection = HarnessServiceConnectSchema.parse(frame);
      void verify()
        .then(() => {
          if (!closed) {
            clearTimeout(timer);
            ready = true;
            connecting = false;
            send({ type: "connected" });
          }
        })
        .catch(fence);
      return;
    }
    if (!ready) {
      fence();
      return;
    }
    if (frame.type === "opening_commit") {
      const pending = openingCommits.get(frame.deliveryId), commit = frame.commit;
      if (!pending || pending.acknowledging || pending.connection !== connection || commit.openingRef !== pending.intent.openingRef || commit.commandFingerprint !== pending.intent.commandFingerprint ||
          commit.processGeneration !== pending.intent.processGeneration || commit.phase !== pending.phase) { fence(); return; }
      pending.acknowledging = true;
      const capturedConnection = connection;
      void verify().then(() => {
        if (closed || server.readyState !== 1 || connection !== capturedConnection || pending.connection !== capturedConnection || openingCommits.get(frame.deliveryId) !== pending) { fence(); return; }
        openingCommits.delete(frame.deliveryId); openingBytes -= pending.bytes; clearTimeout(pending.timer); pending.resolve(commit);
      }).catch(fence);
      return;
    }
    if (
      frame.type !== "request" ||
      activeRequests >= 64 ||
      seen.size >= 512 ||
      seen.has(frame.requestId) ||
      openingBytes + pendingBytes + bytes(event.data) >
        CLOUD_HARNESS_BRIDGE_LIMITS.maxPendingBytes
    ) {
      fence();
      return;
    }
    const operation = frame;
    const size = bytes(event.data);
    seen.add(operation.requestId);
    activeRequests++;
    pendingBytes += size;
    void dispatch(operation)
      .catch(() => {
        try {
          send({
            type: "error",
            requestId: operation.requestId,
            code: "recovery_required",
          });
        } catch {
          fence();
        }
      })
      .finally(() => {
        activeRequests--;
        pendingBytes -= size;
      });
  });
  server.addEventListener("close", fence);
  server.addEventListener("error", fence);
  server.accept();
  return new Response(null, { status: 101, webSocket: client });
}
