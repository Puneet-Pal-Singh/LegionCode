import {
  builtinProviderRegistry,
  normalizeRuntimeModelId,
  ProviderModelRouteResolver,
} from "@repo/provider-core";
import { buildCloudflareAIRoute, buildCloudflareAIRouteHeaders, type CloudflareConnectionConfig } from "@repo/provider-core/discovery";
import type { ProviderConnectionConfig, ProviderModelTransport } from "@repo/shared-types";
import { toOpenAICompatibleBaseURL } from "@legioncode/execution-engine/runtime/provider/ProviderInferenceFactory";
import { ValidationError } from "../../domain/errors";
import type { ProviderConfigService } from "../providers";
import type { ModelSelection } from "./ModelSelectionPolicy";
import type { SDKModelConfig } from "./SDKModelFactory";
import { buildProviderTransportRoute } from "./ProviderRouteMetadata";

type NativeCredentialPort = Pick<ProviderConfigService,
  "getNativeProviderSelection" | "assertNativeProviderSelection" | "resolveCredential" | "resolveManagedAxisMaterial">;

/** Private Native path: one acquired material/config pair, no environment fallback. */
export async function createNativeStructuredModelConfiguration(input: {
  readonly credentials: NativeCredentialPort;
  readonly selection: ModelSelection;
  readonly runtimeModelId?: string;
  readonly providerTransport?: ProviderModelTransport;
  readonly providerEndpoint?: string;
}): Promise<SDKModelConfig> {
  const { credentials, selection } = input;
  const native = credentials.getNativeProviderSelection();
  if (!native || selection.providerId !== native.providerId || selection.model !== native.modelId) throw unsupported();
  credentials.assertNativeProviderSelection(native.providerId, native.modelId);
  const supplied = buildProviderTransportRoute({
    providerId: native.providerId, providerTransport: input.providerTransport, providerEndpoint: input.providerEndpoint,
  });
  const runtimeModelId = normalizeRuntimeModelId(native.providerId, input.runtimeModelId ?? native.modelId);
  if (supplied?.transport === "openai-responses") throw unsupported();

  if (native.providerId === "axis") {
    const material = await credentials.resolveManagedAxisMaterial("axis");
    if (!material || (supplied && (supplied.transport !== "openai-chat-completions" ||
        toOpenAICompatibleBaseURL(supplied.endpoint) !== material.endpoint))) throw unsupported();
    // The managed authority supplied this exact key and endpoint together. Do not
    // feed it into the public BYOK override resolver or reread the environment.
    return { provider: "openai-compatible", apiKey: material.apiKey, baseURL: material.endpoint, model: runtimeModelId };
  }

  const credential = await credentials.resolveCredential(native.providerId);
  if (!credential) throw unsupported();
  const discoveredRoute = supplied ? {
    providerId: native.providerId, modelId: runtimeModelId,
    transport: supplied.transport, endpoint: supplied.endpoint,
  } : undefined;
  const route = new ProviderModelRouteResolver(builtinProviderRegistry, () => unsupported()).resolve({
    providerId: native.providerId, modelId: supplied ? native.modelId : runtimeModelId,
    discoveredRoute, connectionConfig: credential.connectionConfig,
  });
  assertConnectionRoute(credential.connectionConfig, route);
  let provider: SDKModelConfig["provider"], baseURL: string;
  if (route.transport === "openai-chat-completions") {
    provider = "openai-compatible"; baseURL = toOpenAICompatibleBaseURL(route.endpoint);
  } else if (route.transport === "anthropic-messages" && route.endpoint.endsWith("/messages")) {
    provider = "anthropic-native"; baseURL = route.endpoint.slice(0, -"/messages".length);
  } else if (route.transport === "google-generative") {
    provider = "google-native"; baseURL = route.endpoint;
  } else {
    // The installed structured SDK has no Responses transport implementation.
    throw unsupported();
  }
  if (!credential.connectionConfig || !isCloudflareConfig(credential.connectionConfig)) {
    const expected = builtinProviderRegistry.getProvider(native.providerId)?.baseUrl;
    if (!expected || baseURL.replace(/\/$/, "") !== expected.replace(/\/$/, "")) throw unsupported();
  }
  return { provider, apiKey: credential.apiKey, baseURL, model: route.runtimeModelId };
}

function isCloudflareConfig(config: ProviderConnectionConfig): config is CloudflareConnectionConfig {
  return config.providerId === "cloudflare-ai" || config.providerId === "cloudflare-workers-ai" || config.providerId === "cloudflare-ai-gateway";
}

function assertConnectionRoute(
  config: ProviderConnectionConfig | undefined,
  route: { modelId: string; transport: ProviderModelTransport; endpoint: string },
): void {
  if (!config || !isCloudflareConfig(config)) return;
  if (buildCloudflareAIRoute({ config, modelId: route.modelId, transport: route.transport }) !== route.endpoint ||
      Object.keys(buildCloudflareAIRouteHeaders(config) ?? {}).length !== 0) throw unsupported();
}

function unsupported(): ValidationError {
  return new ValidationError("The admitted Native structured provider route or header profile is unsupported.", "INVALID_PROVIDER_SELECTION");
}
