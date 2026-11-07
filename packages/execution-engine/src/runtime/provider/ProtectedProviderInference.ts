import {
  builtinProviderRegistry,
  resolveProviderRuntimeRoute,
} from "@repo/provider-core";
import {
  ProviderIdSchema,
  ProviderConnectionConfigSchema,
  type ProviderConnectionConfig,
  type ProviderId,
} from "@repo/shared-types";
import {
  ProviderError,
  type ProviderAdapter,
  type GenerationParams,
  type GenerationResult,
  type StreamChunk,
} from "./base/ProviderAdapter.js";
import { createProviderInferenceAdapter } from "./ProviderInferenceFactory.js";

/** Trusted process-only credential resolver. Never expose through public SDK or HTTP. */
export interface ProtectedProviderCredential {
  readonly apiKey: string;
  readonly connectionConfig?: ProviderConnectionConfig;
}

export interface ProtectedProviderInferenceOptions {
  readonly providerId: ProviderId;
  readonly modelId: string;
  readonly resolveCredential: (
    providerId: ProviderId,
    signal?: AbortSignal,
  ) => Promise<ProtectedProviderCredential | null>;
}

/** Local provider selection stays explicit; credential material lives only for one request. */
export function createProtectedProviderAdapter(
  options: ProtectedProviderInferenceOptions,
): ProviderAdapter {
  const providerId = ProviderIdSchema.safeParse(options.providerId);
  const provider = providerId.success
    ? builtinProviderRegistry.getProvider(providerId.data)
    : undefined;
  const model = providerId.success
    ? builtinProviderRegistry.getModel(providerId.data, options.modelId)
    : undefined;
  const route = resolveProviderRuntimeRoute(
    options.providerId,
    options.modelId,
  );
  if (
    !providerId.success ||
    !provider ||
    provider.launchStage !== "supported" ||
    !provider.authModes.includes("api_key") ||
    !model ||
    !route
  ) {
    throw configurationFailure();
  }
  // Copy trusted admission settings; later picker changes cannot retarget this adapter.
  const selection = {
    providerId: providerId.data,
    modelId: options.modelId,
    ...route,
  };
  const resolveCredential = options.resolveCredential;

  const resolveAdapter = async (
    params: GenerationParams,
  ): Promise<ProviderAdapter> => {
    assertNotAborted(params.signal);
    if (
      params.model &&
      params.model !== selection.modelId &&
      params.model !== selection.runtimeModelId
    ) {
      throw configurationFailure();
    }
    let credential: ProtectedProviderCredential | null;
    try {
      credential = await resolveCredential(selection.providerId, params.signal);
    } catch {
      assertNotAborted(params.signal);
      throw credentialFailure();
    }
    assertNotAborted(params.signal);
    if (
      !credential ||
      typeof credential.apiKey !== "string" ||
      !credential.apiKey.trim() ||
      credential.apiKey.length > 4096
    ) {
      throw credentialFailure();
    }
    if (credential.connectionConfig !== undefined) {
      const config = ProviderConnectionConfigSchema.safeParse(
        credential.connectionConfig,
      );
      if (!config.success || config.data.providerId !== selection.providerId)
        throw credentialFailure();
    }
    return createProviderInferenceAdapter({
      providerId: selection.providerId,
      transport: selection.providerTransport,
      endpoint: selection.providerEndpoint,
      defaultModel: selection.runtimeModelId,
      apiKey: credential.apiKey,
    });
  };

  return {
    provider: selection.providerId,
    supportedModels: [selection.modelId],
    supportsModel: (modelId) =>
      modelId === selection.modelId || modelId === selection.runtimeModelId,
    async generate(params): Promise<GenerationResult> {
      const adapter = await resolveAdapter(params);
      try {
        const result = await adapter.generate({
          ...params,
          model: selection.runtimeModelId,
        });
        assertNotAborted(params.signal);
        return result;
      } catch (error) {
        throw publicFailure(error, params.signal);
      }
    },
    async *generateStream(
      params,
    ): AsyncGenerator<StreamChunk, GenerationResult, unknown> {
      const adapter = await resolveAdapter(params);
      try {
        return yield* adapter.generateStream({
          ...params,
          model: selection.runtimeModelId,
        });
      } catch (error) {
        throw publicFailure(error, params.signal);
      }
    },
  };
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new ProviderError(
      "native",
      "Provider request was aborted",
      undefined,
      { code: "ABORTED", retryable: false },
    );
}

function configurationFailure(): ProviderError {
  return new ProviderError(
    "native",
    "Selected provider route or model is unavailable",
    undefined,
    { code: "INVALID_PROVIDER_CONFIGURATION", retryable: false },
  );
}

function credentialFailure(): ProviderError {
  return new ProviderError(
    "native",
    "Protected provider credentials are missing or unavailable",
    undefined,
    { code: "AUTH_FAILED", retryable: false },
  );
}

function publicFailure(error: unknown, signal?: AbortSignal): ProviderError {
  assertNotAborted(signal);
  const statusCode =
    error instanceof ProviderError ? error.statusCode : undefined;
  const aborted = error instanceof ProviderError && error.code === "ABORTED";
  const code = aborted
    ? "ABORTED"
    : error instanceof ProviderError && error.code === "TIMEOUT"
      ? "TIMEOUT"
      : error instanceof ProviderError &&
          error.code === "INVALID_RESPONSE_CONTRACT"
        ? "INVALID_RESPONSE_CONTRACT"
        : statusCode === 401 || statusCode === 403
          ? "AUTH_FAILED"
          : error instanceof ProviderError && error.code === "NETWORK_ERROR"
            ? "NETWORK_ERROR"
            : "PROVIDER_UNAVAILABLE";
  // Do not retain provider body, transport message or cause: any may echo the credential.
  return new ProviderError(
    "native",
    aborted
      ? "Provider request was aborted"
      : `Provider request failed${statusCode ? ` (HTTP ${statusCode})` : ""}`,
    undefined,
    {
      code,
      statusCode,
      retryable:
        !aborted && error instanceof ProviderError && error.retryable === true,
    },
  );
}
