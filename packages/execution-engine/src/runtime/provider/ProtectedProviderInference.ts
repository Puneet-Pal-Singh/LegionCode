import {
  builtinProviderRegistry,
  normalizeRuntimeModelId,
  ProviderModelRouteResolver,
  resolveProviderRuntimeRoute,
} from "@repo/provider-core";
import { buildCloudflareAIRoute, buildCloudflareAIRouteHeaders } from "@repo/provider-core/discovery";
import {
  BYOKDiscoveredProviderModelSchema,
  ProviderIdSchema,
  ProviderConnectionConfigSchema,
  type ProviderConnectionConfig,
  type ProviderId,
  type BYOKDiscoveredProviderModel,
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
  readonly model: BYOKDiscoveredProviderModel;
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
  const parsedModel = BYOKDiscoveredProviderModelSchema.safeParse(options.model);
  const fixedRoute = resolveProviderRuntimeRoute(
    options.providerId,
    options.modelId,
  );
  if (
    !providerId.success ||
    !provider ||
    provider.launchStage !== "supported" ||
    !provider.authModes.includes("api_key") ||
    !parsedModel.success ||
    parsedModel.data.providerId !== providerId.data ||
    parsedModel.data.id !== options.modelId ||
    (parsedModel.data.availability !== undefined && parsedModel.data.availability !== "available")
  ) {
    throw configurationFailure();
  }
  // Copy trusted admission settings; later picker changes cannot retarget this adapter.
  const selection = {
    providerId: providerId.data,
    modelId: options.modelId,
    discoveredRoute: fixedRoute
      ? Object.freeze({ providerId: providerId.data, modelId: fixedRoute.runtimeModelId, transport: fixedRoute.providerTransport, endpoint: fixedRoute.providerEndpoint })
      : parsedModel.data.runtimeRoute ? Object.freeze({ ...parsedModel.data.runtimeRoute }) : undefined,
  };
  const runtimeModelId = normalizeRuntimeModelId(selection.providerId, selection.discoveredRoute?.modelId ?? selection.modelId);
  const routeResolver = new ProviderModelRouteResolver(builtinProviderRegistry, () => configurationFailure());
  const resolveCredential = options.resolveCredential;

  const resolveAdapter = async (
    params: GenerationParams,
  ): Promise<ProviderAdapter> => {
    assertNotAborted(params.signal);
    if (
      params.model &&
      params.model !== selection.modelId &&
      params.model !== runtimeModelId
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
    const route = routeResolver.resolve({ ...selection, connectionConfig: credential.connectionConfig });
    const config = credential.connectionConfig;
    const cloudflare = config && (config.providerId === "cloudflare-ai" || config.providerId === "cloudflare-workers-ai" || config.providerId === "cloudflare-ai-gateway") ? config : undefined;
    if (cloudflare && buildCloudflareAIRoute({ config: cloudflare, modelId: selection.modelId, transport: route.transport }) !== route.endpoint) {
      throw configurationFailure();
    }
    return createProviderInferenceAdapter({
      providerId: selection.providerId,
      transport: route.transport,
      endpoint: route.endpoint,
      defaultModel: route.runtimeModelId,
      headers: cloudflare ? buildCloudflareAIRouteHeaders(cloudflare) : undefined,
      apiKey: credential.apiKey,
    });
  };

  return {
    provider: selection.providerId,
    supportedModels: [selection.modelId],
    supportsModel: (modelId) =>
      modelId === selection.modelId || modelId === runtimeModelId,
    async generate(params): Promise<GenerationResult> {
      const adapter = await resolveAdapter(params);
      try {
        const result = await adapter.generate({
          ...params,
          model: runtimeModelId,
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
          model: runtimeModelId,
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
