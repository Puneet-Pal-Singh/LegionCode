import { z } from "zod";
import {
  createAppServerClient,
  AppServerClientError,
} from "../platform/app-server-client.js";
import {
  createAppServerHttpTransport,
  AppServerTransportError,
} from "../platform/app-server-http-transport.js";
import { AppServerProviderErrorSchema } from "@legioncode/app-server/protocol";
import { BYOKDiscoveredProviderModelsQuerySchema } from "./types.js";
import {
  createOperationErrorFromResponse,
  resolveCanonicalRunId,
} from "./transport-support.js";
import {
  ProviderClientOperationError,
  isRetryableProviderClientErrorCode,
  parseProviderOperationErrorCode,
} from "./errors.js";
import type {
  ProviderClientOperationOptions,
  ProviderClientTransport,
} from "./client.js";

export interface ProviderAppServerTransportOptions {
  appServerBaseUrl: string;
  getRunId: () => string | null;
  getHeaders?: () => Record<string, string>;
  fetchImpl?: typeof fetch;
  credentials?: RequestCredentials;
  responsePreviewLimit?: number;
}

/** All hosted provider operations use the existing authenticated App Server boundary. */
export function createProviderAppServerTransport(
  options: ProviderAppServerTransportOptions,
): ProviderClientTransport {
  const invoke = async <T>(
    operationOptions: ProviderClientOperationOptions | undefined,
    action: (
      client: ReturnType<typeof createAppServerClient>,
      runId: string,
    ) => Promise<T>,
  ): Promise<T> => {
    const runId = resolveCanonicalRunId(options.getRunId);
    const suppliedHeaders = new Headers(options.getHeaders?.() ?? {});
    const client = createAppServerClient({
      clientId: "legioncode-provider",
      clientVersion: "0.1.0",
      transport: createAppServerHttpTransport({
        baseUrl: options.appServerBaseUrl,
        credentials: options.credentials ?? "include",
        fetchImpl: async (input, init) => {
          // Provider callers retain their existing explicit authorization header.
          // The generic App Server transport keeps its protected-header policy.
          const headers = new Headers(init?.headers);
          const authorization = suppliedHeaders.get("authorization");
          if (authorization !== null) headers.set("Authorization", authorization);
          const response = await (options.fetchImpl ?? globalThis.fetch)(
            input,
            { ...init, headers },
          );
          if (
            !response.headers.get("content-type")?.includes("application/json")
          ) {
            if (!response.ok)
              throw await createOperationErrorFromResponse(
                response,
                options.responsePreviewLimit ?? 120,
              );
            await response.body?.cancel();
            throw new AppServerTransportError(
              "invalid_response",
              "Expected JSON provider response",
              response.status,
            );
          }
          if (!response.ok) {
            try {
              await response.clone().json();
            } catch {
              throw await createOperationErrorFromResponse(
                response,
                options.responsePreviewLimit ?? 120,
              );
            }
          }
          return response;
        },
        timeoutMs: null,
        maxResponseBytes: null,
        signal: operationOptions?.signal,
        requestHeaders: (envelope) => {
          const headers = new Headers(suppliedHeaders);
          headers.set("X-Run-Id", runId);
          // Preserve the existing large visibility-list contract for this one
          // authenticated hosted operation. Caller hints cannot select a method.
          headers.delete("X-LegionCode-AppServer-Method");
          if (envelope.method === "provider/preferences/update")
            headers.set("X-LegionCode-AppServer-Method", envelope.method);
          return Object.fromEntries(headers);
        },
      }),
    });
    try {
      return await action(client, runId);
    } catch (error) {
      throw providerError(error, operationOptions?.signal);
    }
  };
  return {
    getPreferences: (requestOptions) =>
      invoke(requestOptions, (client, runId) =>
        client.readProviderPreferences(runId),
      ),
    updatePreferences: (params, requestOptions) =>
      invoke(requestOptions, (client, runId) =>
        client.updateProviderPreferences(runId, params),
      ),
    resolveForRun: (params, requestOptions) =>
      invoke(requestOptions, (client, runId) =>
        client.resolveProviderPreferences(runId, params),
      ),
    listCredentials: (requestOptions) =>
      invoke(requestOptions, (client, runId) =>
        client.listProviderCredentials(runId),
      ),
    connectCredential: (params, requestOptions) =>
      invoke(requestOptions, (client, runId) =>
        client.connectProviderCredential(runId, params),
      ),
    updateCredential: (credentialId, params, requestOptions) =>
      invoke(requestOptions, (client, runId) =>
        client.updateProviderCredential(runId, credentialId, params),
      ),
    disconnectCredential: (credentialId, requestOptions) =>
      invoke(requestOptions, (client, runId) =>
        client.disconnectProviderCredential(runId, credentialId),
      ),
    validateCredential: (credentialId, params, requestOptions) =>
      invoke(requestOptions, (client, runId) =>
        client.validateProviderCredential(runId, credentialId, params),
      ),
    discoverProviders: (requestOptions) =>
      invoke(requestOptions, (client, runId) =>
        client.getProviderCatalog(runId),
      ),
    discoverProviderModels: (providerId, query, requestOptions) =>
      invoke(requestOptions, (client, runId) =>
        client.getProviderModels(
          providerId,
          runId,
          BYOKDiscoveredProviderModelsQuerySchema.parse(query),
        ),
      ),
    refreshProviderModels: (providerId, requestOptions) =>
      invoke(requestOptions, (client, runId) =>
        client.refreshProviderModels(providerId, runId),
      ),
  };
}

function providerError(
  error: unknown,
  signal?: AbortSignal,
): ProviderClientOperationError {
  if (error instanceof AppServerClientError) {
    const provider = AppServerProviderErrorSchema.safeParse(error.serverError);
    if (provider.success) {
      const { code, message, retryable, correlationId, statusCode } =
        provider.data;
      const clientCode = parseProviderOperationErrorCode(code);
      return new ProviderClientOperationError(
        clientCode,
        message,
        retryable || isRetryableProviderClientErrorCode(clientCode),
        correlationId,
        statusCode,
      );
    }
    if (error.code === "invalid_response")
      return new ProviderClientOperationError(
        "INVALID_RESPONSE_CONTRACT",
        error.message,
        false,
        undefined,
        502,
      );
    if (error.code === "server_error") {
      if (error.serverCode === "unauthorized")
        return new ProviderClientOperationError(
          parseProviderOperationErrorCode("AUTH_FAILED"),
          error.message,
          false,
          undefined,
          401,
        );
      if (error.serverCode === "server_unavailable")
        return new ProviderClientOperationError(
          "PROVIDER_UNAVAILABLE",
          error.message,
          true,
          undefined,
          503,
        );
      return new ProviderClientOperationError(
        "INVALID_REQUEST_CONTRACT",
        error.message,
        false,
        undefined,
        400,
      );
    }
    const transport = error.cause;
    if (transport instanceof AppServerTransportError) {
      if (transport.cause instanceof ProviderClientOperationError)
        return transport.cause;
      if (transport.code === "invalid_response")
        return new ProviderClientOperationError(
          "INVALID_RESPONSE_FORMAT",
          transport.message,
          false,
          undefined,
          502,
        );
      if (
        transport.code === "aborted" ||
        (transport.cause instanceof Error &&
          transport.cause.name === "AbortError")
      )
        return new ProviderClientOperationError(
          "ABORTED",
          "Request was aborted",
          true,
          undefined,
          0,
        );
    }
  }
  if (error instanceof z.ZodError)
    return new ProviderClientOperationError(
      "INVALID_REQUEST_CONTRACT",
      error.message,
      false,
      undefined,
      400,
    );
  if (signal?.aborted)
    return new ProviderClientOperationError(
      "ABORTED",
      "Request was aborted",
      true,
      undefined,
      0,
    );
  return new ProviderClientOperationError(
    "NETWORK_ERROR",
    error instanceof Error ? error.message : "Network request failed",
    true,
    undefined,
    0,
  );
}
