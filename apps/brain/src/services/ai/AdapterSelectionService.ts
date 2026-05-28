/**
 * AdapterSelectionService - Select and instantiate adapters
 *
 * Single Responsibility: Choose the right adapter based on selection info
 * and provider config state. Enforces strict mode for provider connectivity.
 *
 * Strict Mode (default):
 *   - If provider is not connected, throws ProviderNotConnectedError
 *
 * Compat Mode (BRAIN_RUNTIME_COMPAT_MODE=1):
 *   - Falls back to default adapter with structured logging
 */

import type { ProviderAdapter } from "../providers";
import type { ProviderConfigService } from "../providers";
import type { ModelSelection, RuntimeProvider } from "./ModelSelectionPolicy";
import { getRuntimeProviderFromAdapter } from "./ModelSelectionPolicy";
import type { ProviderTransportRoute } from "./ProviderTransportAdapterFactory";
import { createTransportAdapter } from "./ProviderTransportAdapterFactory";
import {
  createOpenAIAdapter,
  createAnthropicAdapter,
  createGoogleAdapter,
  createLiteLLMAdapter,
} from "./ProviderAdapterFactory";
import type { Env } from "../../types/ai";
import {
  ProviderNotConnectedError,
  ValidationError,
} from "../../domain/errors";
import { ProviderRegistryService } from "../providers";

/**
 * Get the appropriate adapter for a model selection.
 *
 * Strict Mode (default):
 *   - If selection specifies a provider, must be connected
 *   - Throws ProviderNotConnectedError if not connected
 *
 * Compat Mode (BRAIN_RUNTIME_COMPAT_MODE=1):
 *   - Falls back to default adapter if provider not connected
 *   - Logs fallback with structured reason code
 *
 * @param selection - The model selection result
 * @param defaultAdapter - The default adapter instance
 * @param env - Cloudflare environment
 * @param providerConfigService - Optional service for BYOK keys
 * @param correlationId - Optional correlation ID for error tracking
 * @returns The selected adapter
 * @throws ProviderNotConnectedError in strict mode if provider not connected
 */
export async function selectAdapter(
  selection: ModelSelection,
  defaultAdapter: ProviderAdapter,
  env: Env,
  providerConfigService?: ProviderConfigService,
  correlationId?: string,
  route?: ProviderTransportRoute,
): Promise<ProviderAdapter> {
  // If fallback mode or same as default, use default
  if (selection.fallback) {
    return defaultAdapter;
  }

  if (
    !selection.providerId &&
    selection.runtimeProvider ===
      getRuntimeProviderFromAdapter(defaultAdapter.provider)
  ) {
    return defaultAdapter;
  }

  // Try to get override API key if provider was specified
  let overrideApiKey = selection.providerId
    ? ((await providerConfigService?.getApiKey(selection.providerId)) ??
      undefined)
    : undefined;

  if (!overrideApiKey && selection.providerId === "axis") {
    const axisApiKey = env.AXIS_OPENROUTER_API_KEY?.trim();
    overrideApiKey =
      axisApiKey && axisApiKey.length > 0 ? axisApiKey : undefined;
  }

  // Provider was selected but not connected
  if (!overrideApiKey) {
    console.error("[ai/adapter-selection] provider not connected", {
      providerId: selection.providerId ?? selection.runtimeProvider,
      correlationId,
    });
    throw new ProviderNotConnectedError(
      selection.providerId ?? selection.runtimeProvider,
      correlationId,
    );
  }

  if (route) {
    return createTransportAdapter(route, env, overrideApiKey);
  }

  return createAdapterForProvider(
    selection.providerId,
    selection.runtimeProvider,
    env,
    overrideApiKey,
  );
}

/**
 * Create an adapter for a specific runtime provider.
 * @param provider - The runtime provider type
 * @param env - Cloudflare environment
 * @param overrideApiKey - The API key to use
 * @returns Configured ProviderAdapter
 */
function createAdapterForProvider(
  providerId: string | undefined,
  provider: RuntimeProvider,
  env: Env,
  overrideApiKey: string,
): ProviderAdapter {
  const familyFactory = ADAPTER_FAMILY_FACTORIES[provider];
  if (!familyFactory) {
    throw new ValidationError(
      `Adapter family "${provider}" is not configured for runtime dispatch.`,
      "UNKNOWN_PROVIDER",
    );
  }
  return familyFactory(providerId, env, overrideApiKey);
}

const providerRegistryService = new ProviderRegistryService();

const ADAPTER_FAMILY_FACTORIES: Record<
  RuntimeProvider,
  (
    providerId: string | undefined,
    env: Env,
    overrideApiKey: string,
  ) => ProviderAdapter
> = {
  "anthropic-native": (_providerId, env, overrideApiKey) =>
    createAnthropicAdapter(env, overrideApiKey),
  "openai-compatible": (providerId, env, overrideApiKey) => {
    if (!providerId) {
      return createLiteLLMAdapter(env, overrideApiKey);
    }
    const providerEntry = providerRegistryService.getProvider(providerId);
    if (!providerEntry) {
      throw new ValidationError(
        `Provider "${providerId}" is not registered for adapter dispatch.`,
        "INVALID_PROVIDER_SELECTION",
      );
    }
    return createOpenAIAdapter(env, overrideApiKey, providerEntry.baseUrl);
  },
  "google-native": (providerId, env, overrideApiKey) => {
    const resolvedProviderId = providerId ?? "google";
    const providerEntry =
      providerRegistryService.getProvider(resolvedProviderId);
    if (!providerEntry) {
      throw new ValidationError(
        `Provider "${resolvedProviderId}" is not registered for adapter dispatch.`,
        "INVALID_PROVIDER_SELECTION",
      );
    }
    return createGoogleAdapter(env, overrideApiKey, providerEntry.baseUrl);
  },
  "custom-http": () => {
    throw new ValidationError(
      "Custom-http adapter family is not wired for runtime inference yet.",
      "UNKNOWN_PROVIDER",
    );
  },
};
