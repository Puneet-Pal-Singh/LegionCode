import {
  isLaunchSupportedProvider,
  isLaunchVisibleProvider,
  type ProviderAdapterFamily,
  type ProviderCapabilityFlags,
  type ProviderRegistryEntry,
  type ProviderValidationAuthMode,
} from "@repo/shared-types";
import { builtinProviderRegistry } from "@repo/provider-core";
import type {
  ProviderExecutionProfile,
  ProviderExecutionLaneSupport,
  LLMExecutionLatencyTier,
  LLMExecutionReliabilityTier,
} from "@shadowbox/execution-engine/runtime";

// Plan 82: latencyTier and reliabilityTier are informational only.
// They must NOT be used as lane rejection criteria.

export interface ProviderValidationConfig {
  endpoint: string;
  authMode: ProviderValidationAuthMode;
  headers?: Record<string, string>;
}

export interface ProviderDiscoveryConfig {
  adapterFamily: ProviderAdapterFamily;
  endpoint?: string;
}

export class ProviderRegistryService {
  private readonly entriesById: Map<string, ProviderRegistryEntry>;

  constructor(
    entries: ProviderRegistryEntry[] = builtinProviderRegistry.listProviders(),
  ) {
    this.entriesById = new Map(
      entries.map((entry) => [entry.providerId, { ...entry }]),
    );
  }

  listProviders(): ProviderRegistryEntry[] {
    return Array.from(this.entriesById.values()).map((entry) => ({ ...entry }));
  }

  listLaunchVisibleProviders(): ProviderRegistryEntry[] {
    return this.listProviders().filter(isLaunchVisibleProvider);
  }

  listLaunchSupportedProviders(): ProviderRegistryEntry[] {
    return this.listProviders().filter(isLaunchSupportedProvider);
  }

  listProviderIds(): string[] {
    return Array.from(this.entriesById.keys());
  }

  getProvider(providerId: string): ProviderRegistryEntry | undefined {
    const entry = this.entriesById.get(providerId);
    return entry ? { ...entry } : undefined;
  }

  getProviderCapabilities(
    providerId: string,
  ): ProviderCapabilityFlags | undefined {
    return this.getProvider(providerId)?.capabilities;
  }

  getDefaultModel(providerId: string): string | undefined {
    return this.getProvider(providerId)?.defaultModelId;
  }

  getExecutionProfile(
    providerId: string,
    modelId: string,
  ): ProviderExecutionProfile | undefined {
    const provider = this.getProvider(providerId);
    if (!provider) {
      return undefined;
    }

    const latencyTier = resolveLatencyTier(providerId, modelId);
    const reliabilityTier = resolveReliabilityTier(providerId, modelId);

    return {
      latencyTier,
      reliabilityTier,
      supportedLanes: {
        chat_only: supportedLane(),
        single_agent_action: resolveActionLaneSupport(provider),
        structured_planning_required: resolveStructuredLaneSupport(provider),
      },
    };
  }

  isProviderRegistered(providerId: string): boolean {
    return this.entriesById.has(providerId);
  }

  isApiKeyFormatValid(providerId: string, apiKey: string): boolean {
    const entry = this.getProvider(providerId);
    if (!entry) {
      return false;
    }

    const keyFormat = entry.keyFormat;
    if (!keyFormat) {
      return apiKey.length > 0;
    }

    if (keyFormat.prefix && !apiKey.startsWith(keyFormat.prefix)) {
      return false;
    }

    if (keyFormat.regex) {
      try {
        const pattern = new RegExp(keyFormat.regex);
        if (!pattern.test(apiKey)) {
          return false;
        }
      } catch {
        return false;
      }
    }

    return apiKey.length > 0;
  }

  getValidationConfig(
    providerId: string,
  ): ProviderValidationConfig | undefined {
    const provider = this.getProvider(providerId);
    if (!provider?.validation) {
      return undefined;
    }

    return {
      endpoint: provider.validation.endpoint,
      authMode: provider.validation.authMode,
      headers: provider.validation.headers
        ? { ...provider.validation.headers }
        : undefined,
    };
  }

  getDiscoveryConfig(providerId: string): ProviderDiscoveryConfig | undefined {
    const provider = this.getProvider(providerId);
    if (!provider) {
      return undefined;
    }

    return {
      adapterFamily: provider.adapterFamily,
      endpoint: resolveDiscoveryEndpoint(provider),
    };
  }
}

function resolveDiscoveryEndpoint(
  provider: ProviderRegistryEntry,
): string | undefined {
  if (provider.modelsEndpoint) {
    return provider.modelsEndpoint;
  }

  if (!provider.baseUrl) {
    return undefined;
  }

  if (provider.adapterFamily === "openai-compatible") {
    return `${provider.baseUrl.replace(/\/$/, "")}/models`;
  }

  return undefined;
}

function supportedLane(reason?: string): ProviderExecutionLaneSupport {
  return {
    supported: true,
    reason,
  };
}

function blockedLane(reason: string): ProviderExecutionLaneSupport {
  return {
    supported: false,
    reason,
  };
}

function resolveActionLaneSupport(
  provider: ProviderRegistryEntry,
): ProviderExecutionLaneSupport {
  if (!provider.capabilities.tools) {
    return blockedLane("Selected provider does not support tool calling.");
  }

  return supportedLane();
}

function resolveStructuredLaneSupport(
  provider: ProviderRegistryEntry,
): ProviderExecutionLaneSupport {
  if (!provider.capabilities.tools) {
    return blockedLane("Structured planning requires tool-calling support.");
  }

  if (!provider.capabilities.structuredOutputs) {
    return blockedLane(
      "Structured planning requires structured output support.",
    );
  }

  if (!supportsStructuredPlanningTransport(provider)) {
    return blockedLane(
      "Structured planning requires JSON mode or a native structured-output provider transport.",
    );
  }

  return supportedLane();
}

function supportsStructuredPlanningTransport(
  provider: ProviderRegistryEntry,
): boolean {
  return (
    provider.capabilities.jsonMode ||
    provider.adapterFamily === "anthropic-native" ||
    provider.adapterFamily === "google-native"
  );
}

function resolveLatencyTier(
  providerId: string,
  modelId: string,
): LLMExecutionLatencyTier {
  const normalizedModelId = modelId.toLowerCase();
  if (providerId === "groq") {
    return "fast";
  }
  if (providerId === "axis" || normalizedModelId.includes(":free")) {
    return "slow";
  }
  if (isLikelySlowModel(normalizedModelId)) {
    return "slow";
  }
  return "standard";
}

function resolveReliabilityTier(
  providerId: string,
  modelId: string,
): LLMExecutionReliabilityTier {
  if (providerId === "openai" || providerId === "anthropic") {
    return "hardened";
  }
  if (providerId === "groq") {
    return "baseline";
  }
  if (providerId === "axis" || modelId.includes(":free")) {
    return "experimental";
  }
  return "baseline";
}

function isLikelySlowModel(modelId: string): boolean {
  if (modelId.includes("gemma") || modelId.includes("nemotron")) {
    return true;
  }

  return /(?:^|[^0-9])(3[1-9]b|[4-9][0-9]b|[1-9][0-9]{2,}b)(?:$|[^0-9])/.test(
    modelId,
  );
}
