import type {
  ProviderConnectionConfig,
  ProviderModelRuntimeRoute,
  ProviderModelTransport,
} from "@repo/shared-types";
import { ValidationError } from "../../domain/errors";
import { ProviderRegistryService } from "../providers";

const MIXED_TRANSPORT_PROVIDERS = new Set(["opencode-zen", "cloudflare-ai"]);

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

export class ProviderModelRouteResolver {
  constructor(
    private readonly registryService = new ProviderRegistryService(),
  ) {}

  resolve(input: ProviderModelRouteInput): ProviderModelRoute {
    this.assertProviderRegistered(input.providerId);
    if (input.discoveredRoute) {
      return this.resolveDiscoveredRoute(input);
    }
    return this.resolveDefaultRoute(input);
  }

  private resolveDiscoveredRoute(
    input: ProviderModelRouteInput,
  ): ProviderModelRoute {
    const route = input.discoveredRoute;
    if (!route) {
      throw new ValidationError(
        "Discovered route is required.",
        "INVALID_PROVIDER_SELECTION",
      );
    }
    if (route.providerId !== input.providerId) {
      throw new ValidationError(
        "Discovered route providerId must match selected providerId.",
        "INVALID_PROVIDER_SELECTION",
      );
    }
    if (input.providerId === "cloudflare-ai") {
      this.assertCloudflareConfig(input.connectionConfig);
    }
    return {
      providerId: input.providerId,
      modelId: input.modelId,
      runtimeModelId: normalizeRuntimeModelId(input.providerId, route.modelId),
      transport: route.transport,
      endpoint: route.endpoint,
    };
  }

  private resolveDefaultRoute(
    input: ProviderModelRouteInput,
  ): ProviderModelRoute {
    if (MIXED_TRANSPORT_PROVIDERS.has(input.providerId)) {
      throw new ValidationError(
        `Provider "${input.providerId}" requires model runtime route metadata.`,
        "INVALID_PROVIDER_SELECTION",
      );
    }

    const provider = this.registryService.getProvider(input.providerId);
    if (!provider?.baseUrl) {
      throw new ValidationError(
        `Provider "${input.providerId}" does not declare a runtime base URL.`,
        "INVALID_PROVIDER_SELECTION",
      );
    }

    if (provider.adapterFamily === "google-native") {
      return {
        providerId: input.providerId,
        modelId: input.modelId,
        runtimeModelId: normalizeRuntimeModelId(
          input.providerId,
          input.modelId,
        ),
        transport: "google-generative",
        endpoint: provider.baseUrl,
      };
    }

    if (provider.adapterFamily === "openai-compatible") {
      return {
        providerId: input.providerId,
        modelId: input.modelId,
        runtimeModelId: normalizeRuntimeModelId(
          input.providerId,
          input.modelId,
        ),
        transport: "openai-chat-completions",
        endpoint: `${provider.baseUrl.replace(/\/$/, "")}/chat/completions`,
      };
    }

    throw new ValidationError(
      `Provider "${input.providerId}" requires explicit route metadata for adapter family "${provider.adapterFamily}".`,
      "INVALID_PROVIDER_SELECTION",
    );
  }

  private assertProviderRegistered(providerId: string): void {
    if (this.registryService.isProviderRegistered(providerId)) {
      return;
    }
    throw new ValidationError(
      `Provider "${providerId}" is not registered.`,
      "INVALID_PROVIDER_SELECTION",
    );
  }

  private assertCloudflareConfig(
    config: ProviderConnectionConfig | undefined,
  ): void {
    if (config?.providerId === "cloudflare-ai") {
      return;
    }
    throw new ValidationError(
      "Cloudflare AI requires connection config before route resolution.",
      "INVALID_PROVIDER_SELECTION",
    );
  }
}

function normalizeRuntimeModelId(providerId: string, modelId: string): string {
  const providerPrefix = `${providerId}/`;
  if (modelId.startsWith(providerPrefix)) {
    return modelId.slice(providerPrefix.length);
  }
  return modelId;
}
