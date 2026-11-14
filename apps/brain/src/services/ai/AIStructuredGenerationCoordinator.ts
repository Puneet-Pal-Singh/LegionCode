import type { ProviderModelTransport } from "@repo/shared-types";
import type { Env } from "../../types/ai";
import type { ProviderConfigService } from "../providers";
import { AXIS_PROVIDER_ID } from "../providers/axis";
import { consumeAxisQuotaIfNeeded } from "./axis-quota";
import type { ModelSelection } from "./ModelSelectionPolicy";
import {
  createNativeStructuredModelConfiguration,
  type NativeStructuredModelConfiguration,
} from "./NativeStructuredModelConfiguration";
import {
  resolveStructuredBaseURLOverride,
  resolveStructuredRuntimeProvider,
} from "./ProviderRouteMetadata";
import { getSDKModelConfig } from "./SDKModelFactory";

type StructuredGenerationConfiguration = NativeStructuredModelConfiguration & {
  readonly nativeStructured: boolean;
};

/** Resolve quota and credential-bound configuration; AIService owns SDK execution. */
export async function resolveStructuredGenerationConfiguration({
  selection,
  env,
  providerConfigService,
  runtimeModelId,
  providerTransport,
  providerEndpoint,
}: {
  selection: ModelSelection;
  env: Env;
  providerConfigService?: ProviderConfigService;
  runtimeModelId?: string;
  providerTransport?: ProviderModelTransport;
  providerEndpoint?: string;
}): Promise<StructuredGenerationConfiguration> {
  await consumeAxisQuotaIfNeeded(selection.providerId, providerConfigService);
  const nativeStructured = Boolean(providerConfigService?.getNativeProviderSelection?.());
  if (nativeStructured && providerConfigService) {
    const native = await createNativeStructuredModelConfiguration({
      credentials: providerConfigService, selection, runtimeModelId, providerTransport, providerEndpoint,
    });
    return { ...native, nativeStructured };
  }
  const acquiredKey = selection.providerId && selection.providerId !== AXIS_PROVIDER_ID
    ? await providerConfigService?.getApiKey(selection.providerId)
    : undefined;
  const overrideApiKey = acquiredKey === null ? undefined : acquiredKey;
  const structuredRuntimeProvider = resolveStructuredRuntimeProvider(selection.runtimeProvider, providerTransport);
  const structuredBaseURLOverride = resolveStructuredBaseURLOverride(providerTransport, providerEndpoint);
  return {
    kind: "sdk",
    nativeStructured,
    config: getSDKModelConfig(
      runtimeModelId ?? selection.model, structuredRuntimeProvider, env,
      overrideApiKey, selection.providerId, structuredBaseURLOverride,
    ),
  };
}
