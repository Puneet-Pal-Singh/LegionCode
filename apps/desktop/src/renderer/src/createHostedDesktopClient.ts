import {
  AppServerTransportError,
  createAppServerClient,
  type AppServerTransport,
} from "@legioncode/sdk";
import {
  HostedRequestScopeSchema,
  parseHostedEnvelope,
  type HostedRequestScope,
  type HostedResponseMetadata,
} from "../../shared/hosted-request";

function responseMetadata(value: HostedResponseMetadata): { status: number; headers: Headers } {
  const headers = new Headers();
  const fields: readonly (readonly [string, string | null])[] = [
    ["X-Run-Id", value.runId], ["X-Thread-Id", value.threadId],
    ["X-Turn-Id", value.turnId], ["X-Run-Attempt-Id", value.runAttemptId],
  ];
  for (const [name, item] of fields) {
    if (item !== null) headers.set(name, item);
  }
  return { status: value.status, headers };
}

/** Capture one authenticated placement. The host never silently retargets this client. */
export function createHostedDesktopTransport(scope: HostedRequestScope): AppServerTransport {
  const captured = Object.freeze(HostedRequestScopeSchema.parse(scope));
  const requestWithMetadata: NonNullable<AppServerTransport["requestWithMetadata"]> = async (
    envelope, serializedEnvelope, onResponse, beforeSend,
  ) => {
    const candidate = serializedEnvelope ?? JSON.stringify(envelope);
    // SDK frozen-byte identity and dispatch observation run before crossing IPC.
    const body = beforeSend ? beforeSend(candidate) : candidate;
    const parsed = parseHostedEnvelope(body);
    if (parsed.method !== envelope.method) throw new Error("Hosted request method changed before dispatch");
    let metadata: ReturnType<typeof responseMetadata> | null = null;
    const result = await window.desktop.hostedRequest({
      requestId: crypto.randomUUID(), scope: captured, serializedEnvelope: body,
    }, (observed) => {
      metadata = responseMetadata(observed);
      onResponse?.(metadata);
    });
    if (!result.ok) throw new AppServerTransportError(result.error.code, result.error.message, result.error.statusCode);
    if (!metadata) throw new AppServerTransportError("invalid_response", "Hosted response metadata is unavailable");
    return { payload: result.payload, metadata };
  };
  return {
    request: async (envelope, serializedEnvelope) => (await requestWithMetadata(envelope, serializedEnvelope)).payload,
    requestWithMetadata,
  };
}

export function createHostedDesktopClient(scope: HostedRequestScope, options: { clientVersion: string }) {
  return createAppServerClient({
    clientId: "legioncode-desktop-hosted", clientVersion: options.clientVersion,
    transport: createHostedDesktopTransport(scope),
  });
}
