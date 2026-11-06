import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import {
  HarnessServiceCapabilityRequestSchema,
  HarnessServiceCapabilitySchema,
  HarnessServiceConnectSchema,
  HarnessServiceWorkerFrameSchema,
  HarnessServiceHostFrameSchema,
  HarnessServiceResultSchema,
  type HarnessServiceRequest,
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
  const [client, server] = Object.values(pair);
  let closed = false;
  let activeRequests = 0;
  let pendingBytes = 0;
  const seen = new Set<string>();
  let connection:
    | ReturnType<typeof HarnessServiceConnectSchema.parse>
    | undefined;
  let connecting = false;
  let ready = false;
  const timer = setTimeout(() => fence(), 10_000);
  const fence = () => {
    if (closed) return;
    closed = true;
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
    if (!connection) throw new Error("Harness service handshake required");
    const scope = connection.scope;
    const stub = env.AGENT_RUNTIME.get(
      env.AGENT_RUNTIME.idFromName(scope.sessionId),
    );
    const record = await stub.getHarnessExecutionSession(connection.lease);
    if (!record) throw new Error("Harness checkout lease unavailable");
    const lease = SessionCreateResponseSchema.shape.lease.parse(record.lease);
    const a = new TextEncoder().encode(bearer),
      b = new TextEncoder().encode(record.token);
    let diff = a.length ^ b.length;
    for (let i = 0; i < Math.max(a.length, b.length); i++)
      diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
    if (
      diff ||
      lease.leaseId !== connection.lease.leaseId ||
      lease.sandboxId !== connection.lease.sandboxId ||
      lease.generation !== connection.lease.generation ||
      lease.workspaceScope.runId !== scope.runId ||
      lease.workspaceScope.workspaceId !== scope.workspaceId ||
      lease.workspaceScope.threadId !== scope.threadId ||
      lease.workspaceScope.turnId !== scope.turnId ||
      lease.workspaceScope.runAttemptId !== scope.runAttemptId
    )
      throw new Error("Harness checkout ownership mismatch");
    // Cleanup remains lease/process scoped even after provider auth revocation.
    // Missing/replaced leases never create/borrow a replacement checkout.
    return { record, lease };
  };
  const dispatch = async (operation: HarnessServiceRequest) => {
    const target = cloudHarnessRequestTarget(operation);
    await verify();
    if (!isCloudHarnessCleanup(target)) {
      send({
        type: "error",
        requestId: operation.requestId,
        code: "unavailable",
      });
      return;
    }
    if (target.session.runAttemptId !== connection!.scope.runAttemptId)
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
          if (!sameCloudHarnessSession(requested.session, target.session))
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
    if (
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
    if (
      frame.type !== "request" ||
      activeRequests >= 64 ||
      seen.size >= 512 ||
      seen.has(frame.requestId) ||
      pendingBytes + bytes(event.data) >
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
