import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import { z } from "zod";
import { SessionCreateResponseSchema } from "../schemas/http-api";
import { composeCloudHarnessRuntime } from "../factories/RuntimeCompositionFactory";
import {
  CloudHarnessRequestSchema,
  CloudHarnessResultSchema,
  cloudHarnessRequestTarget,
  isCloudHarnessCleanup,
  sameCloudHarnessSession,
} from "./CloudHarnessBridgeProtocol";
import { assertCloudHarnessLaunchAvailable } from "./CloudHarnessAvailability";
import {
  CLOUD_HARNESS_BRIDGE_LIMITS,
  encodeCloudHarnessBridgeFrame,
} from "./CloudHarnessBridgeLimits";

/** HTTP transport wrapper only; domain request and lease schemas are reused.
 * Brain's existing authenticated SECURE_API Fetcher calls this route.
 */
export const CloudHarnessServiceRequestSchema = z
  .object({
    runtimeSessionId: z.string().min(1).max(256),
    lease: SessionCreateResponseSchema.shape.lease,
    request: CloudHarnessRequestSchema,
  })
  .strict();
export const CLOUD_HARNESS_CLEANUP_SECRET_HEADER =
  "X-Legion-Harness-Cleanup-Secret";

interface CloudHarnessServiceEnvironment {
  Sandbox: DurableObjectNamespace<Sandbox>;
  AGENT_RUNTIME: {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): {
      getExecutionSession(
        sessionId: string,
      ): Promise<{ lease: unknown } | null>;
    };
  };
}

async function readBody(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("Invalid cloud harness request");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > CLOUD_HARNESS_BRIDGE_LIMITS.maxFrameBytes)
        throw new Error("Cloud harness request exceeds limit");
      chunks.push(value);
    }
  } catch {
    try {
      await reader.cancel();
    } catch {
      /* Never expose body/cleanup errors. */
    }
    throw new Error("Invalid cloud harness request");
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Call ONLY after the existing internal-service secret guard. No JS environment
 * factories, provider credentials, preview endpoints, or new admission authority.
 */
export async function handleCloudHarnessDispatch(
  request: Request,
  env: CloudHarnessServiceEnvironment,
): Promise<Response> {
  let body: z.infer<typeof CloudHarnessServiceRequestSchema>;
  try {
    body = CloudHarnessServiceRequestSchema.parse(await readBody(request));
    encodeCloudHarnessBridgeFrame(body);
  } catch {
    return Response.json({ code: "invalid_request" }, { status: 400 });
  }
  const operation = body.request;
  const target = cloudHarnessRequestTarget(operation);
  const error = (code: "unavailable" | "recovery_required", status: number) =>
    Response.json(
      { type: "error", requestId: operation.requestId, code },
      { status },
    );
  // The actual service boundary truthfully rejects all provider-affecting work
  // BEFORE credential injection, sandbox bootstrap, or durable command dispatch.
  if (!isCloudHarnessCleanup(target)) return error("unavailable", 503);
  const cleanupSecret =
    request.headers.get(CLOUD_HARNESS_CLEANUP_SECRET_HEADER) ?? "";
  if (!/^[A-Za-z0-9_-]{43,256}$/.test(cleanupSecret))
    return error("recovery_required", 403);
  const stub = env.AGENT_RUNTIME.get(
    env.AGENT_RUNTIME.idFromName(body.runtimeSessionId),
  );
  const expectedLease = body.lease;
  const assertOwned = async () => {
    const persisted = await stub.getExecutionSession(body.runtimeSessionId);
    const actual = SessionCreateResponseSchema.shape.lease.parse(
      persisted?.lease,
    );
    if (
      JSON.stringify(actual) !== JSON.stringify(expectedLease) ||
      actual.workspaceScope.runAttemptId !== target.session.runAttemptId
    )
      throw new Error("Cloud harness cleanup ownership mismatch");
    // Expired/revoked inference credentials are intentionally irrelevant here.
    // A missing/replaced lease never creates or borrows a replacement checkout.
    return actual;
  };
  try {
    await assertOwned();
    const { execution: port } = composeCloudHarnessRuntime(
      {
        assertActive: async () => assertCloudHarnessLaunchAvailable(),
        assertCleanup: async (requested) => {
          if (!sameCloudHarnessSession(requested.session, target.session))
            throw new Error("Cloud harness cleanup generation mismatch");
          await assertOwned();
        },
        sandbox: async () => {
          const lease = await assertOwned();
          return getSandbox(env.Sandbox, lease.sandboxId);
        },
        bridgeCredential: async () => {
          throw new Error("Cloud harness provider work unavailable");
        },
        cleanupBridgeCredential: async () => {
          await assertOwned();
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
      return Response.json(
        CloudHarnessResultSchema.parse({
          type: "result",
          requestId: operation.requestId,
          operation: "control",
          value,
        }),
      );
    }
    if (operation.operation === "quiescence") {
      const value = await port.awaitQuiescence({
        session: operation.session,
        timeoutMs: operation.timeoutMs,
      });
      return Response.json(
        CloudHarnessResultSchema.parse({
          type: "result",
          requestId: operation.requestId,
          operation: "quiescence",
          value,
        }),
      );
    }
    return error("unavailable", 503);
  } catch {
    return error("recovery_required", 409);
  }
}
