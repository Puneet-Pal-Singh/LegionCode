import { AppServerResponseSchema } from "@legioncode/app-server/protocol";
import { AppServerTransportError, createAppServerHttpTransport } from "@legioncode/sdk";
import {
  HostedRequestSchema,
  HostedRequestResultSchema,
  HostedResponseMetadataSchema,
  hostedRequestHeaders,
  parseHostedEnvelope,
  type HostedRequestResult,
  type HostedResponseEvent,
  type HostedResponseMetadata,
} from "../shared/hosted-request";
import type { DesktopHostedAccount } from "./hosted-account";

const BRAIN = "https://brain.legioncode.dev";

/** HTTP adaptation only; hosted authentication, admission and runtime remain canonical. */
export class DesktopHostedAppServer {
  private readonly pending = new Set<string>();

  constructor(private readonly account: Pick<DesktopHostedAccount, "run">) {}

  async request(value: unknown, onResponse: (event: HostedResponseEvent) => void): Promise<HostedRequestResult> {
    const input = HostedRequestSchema.parse(value);
    const request = parseHostedEnvelope(input.serializedEnvelope);
    let metadata: HostedResponseMetadata | null = null;
    let invalidMetadata = false;
    if (this.pending.has(input.requestId) || this.pending.size >= 64) throw new Error("Hosted request is already pending or unavailable");
    this.pending.add(input.requestId);
    try {
      const payload = await this.account.run(input.scope, async (session) => {
        const transport = createAppServerHttpTransport({
          baseUrl: BRAIN, credentials: "include", timeoutMs: null,
          acceptThreadInputConflict: true,
          requestHeaders: (envelope) => hostedRequestHeaders(envelope.method),
          fetchImpl: (url, options) => {
            if (url !== `${BRAIN}/app-server/request`) throw new Error("Hosted endpoint is unavailable");
            return session.fetch(url, options);
          },
        });
        const result = await transport.requestWithMetadata!(request, input.serializedEnvelope, (observed) => {
          const parsed = HostedResponseMetadataSchema.safeParse({
            status: observed.status,
            runId: observed.headers.get("X-Run-Id"),
            threadId: observed.headers.get("X-Thread-Id"),
            turnId: observed.headers.get("X-Turn-Id"),
            runAttemptId: observed.headers.get("X-Run-Attempt-Id"),
          });
          if (!parsed.success) { invalidMetadata = true; return; }
          metadata = parsed.data;
          // A destroyed renderer or failed notification never abandons the original body read.
          try { onResponse({ requestId: input.requestId, scope: input.scope, metadata }); } catch { /* Result includes the same receipt. */ }
        });
        if (invalidMetadata) throw new Error("Hosted response metadata was invalid");
        const response = AppServerResponseSchema.parse(result.payload);
        if (response.method !== request.method) throw new Error("Hosted response method mismatch");
        return response;
      });
      return HostedRequestResultSchema.parse({ requestId: input.requestId, scope: input.scope, ok: true, payload, metadata });
    } catch (error) {
      return HostedRequestResultSchema.parse({
        requestId: input.requestId, scope: input.scope, ok: false, metadata,
        error: {
          code: error instanceof AppServerTransportError ? error.code : "transport",
          message: "Hosted App Server request failed",
          ...(error instanceof AppServerTransportError && error.statusCode !== undefined ? { statusCode: error.statusCode } : {}),
        },
      });
    } finally {
      // The original SDK request, including body settlement and scope recheck, has returned.
      this.pending.delete(input.requestId);
    }
  }
}
