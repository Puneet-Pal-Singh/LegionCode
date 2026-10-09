import type {
  ProviderConnectionConfig,
  ProviderModelRuntimeRoute,
  ProviderModelTransport,
  ProviderAdapterFamily,
} from "@repo/shared-types";

const MIXED_TRANSPORT_PROVIDERS = new Set([
  "opencode-go",
  "opencode-zen",
  "cloudflare-ai",
  "cloudflare-workers-ai",
  "cloudflare-ai-gateway",
]);

const CLOUDFLARE_PROVIDERS = new Set([
  "cloudflare-ai",
  "cloudflare-workers-ai",
  "cloudflare-ai-gateway",
]);

export interface ProviderModelRoute {
  providerId: string;
  modelId: string;
  runtimeModelId: string;
  transport: ProviderModelTransport;
  endpoint: string;
}

export interface ProviderModelRouteInput {
  providerId: string;
  modelId: string;
  discoveredRoute?: ProviderModelRuntimeRoute;
  connectionConfig?: ProviderConnectionConfig;
}

export interface ProviderRouteRegistryEntry {
  baseUrl?: string;
  adapterFamily?: ProviderAdapterFamily;
}

export type GetProvider = (
  providerId: string,
) => ProviderRouteRegistryEntry | undefined;

export class ProviderRouteResolutionError extends Error {
  readonly code = "INVALID_PROVIDER_SELECTION";

  constructor(message: string) {
    super(message);
    this.name = "ProviderRouteResolutionError";
  }
}

export function resolveProviderModelRoute(
  input: ProviderModelRouteInput,
  getProvider: GetProvider,
): ProviderModelRoute {
  const provider = getProvider(input.providerId);
  if (!provider) {
    throw new ProviderRouteResolutionError(
      `Provider "${input.providerId}" is not registered.`,
    );
  }

  if (input.discoveredRoute) {
    return resolveDiscoveredRoute(input);
  }
  return resolveDefaultRoute(input, provider);
}

function resolveDiscoveredRoute(
  input: ProviderModelRouteInput,
): ProviderModelRoute {
  const route = input.discoveredRoute;
  if (!route) {
    throw new ProviderRouteResolutionError("Discovered route is required.");
  }
  if (route.providerId !== input.providerId) {
    throw new ProviderRouteResolutionError(
      "Discovered route providerId must match selected providerId.",
    );
  }
  if (CLOUDFLARE_PROVIDERS.has(input.providerId)) {
    assertCloudflareConfig(input.providerId, input.connectionConfig);
  }
  return {
    providerId: input.providerId,
    modelId: input.modelId,
    runtimeModelId: normalizeRuntimeModelId(input.providerId, route.modelId),
    transport: route.transport,
    endpoint: route.endpoint,
  };
}

function resolveDefaultRoute(
  input: ProviderModelRouteInput,
  provider: ProviderRouteRegistryEntry,
): ProviderModelRoute {
  if (MIXED_TRANSPORT_PROVIDERS.has(input.providerId)) {
    throw new ProviderRouteResolutionError(
      `Provider "${input.providerId}" requires model runtime route metadata.`,
    );
  }

  if (!provider.baseUrl) {
    throw new ProviderRouteResolutionError(
      `Provider "${input.providerId}" does not declare a runtime base URL.`,
    );
  }

  if (provider.adapterFamily === "google-native") {
    return {
      providerId: input.providerId,
      modelId: input.modelId,
      runtimeModelId: normalizeRuntimeModelId(input.providerId, input.modelId),
      transport: "google-generative",
      endpoint: provider.baseUrl,
    };
  }

  if (provider.adapterFamily === "openai-compatible") {
    return {
      providerId: input.providerId,
      modelId: input.modelId,
      runtimeModelId: normalizeRuntimeModelId(input.providerId, input.modelId),
      transport: "openai-chat-completions",
      endpoint: `${provider.baseUrl.replace(/\/$/, "")}/chat/completions`,
    };
  }

  throw new ProviderRouteResolutionError(
    `Provider "${input.providerId}" requires explicit route metadata for adapter family "${provider.adapterFamily}".`,
  );
}

function assertCloudflareConfig(
  providerId: string,
  config: ProviderConnectionConfig | undefined,
): void {
  if (config?.providerId === providerId) {
    return;
  }
  throw new ProviderRouteResolutionError(
    "Cloudflare AI requires connection config before route resolution.",
  );
}

function normalizeRuntimeModelId(providerId: string, modelId: string): string {
  const providerPrefix = `${providerId}/`;
  return modelId.startsWith(providerPrefix)
    ? modelId.slice(providerPrefix.length)
    : modelId;
}
