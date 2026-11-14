import type { ProviderConfigService } from "../providers";
import type { ModelSelection } from "./ModelSelectionPolicy";
import { ValidationError } from "../../domain/errors";

type SelectionProviderConfig = Pick<ProviderConfigService, "getPreferences" | "isConnected"> &
  Partial<Pick<ProviderConfigService, "getNativeProviderSelection" | "assertNativeProviderSelection">>;

interface SelectionResolutionInput {
  providerId?: string;
  modelId?: string;
  providerConfigService?: SelectionProviderConfig;
  resolveSelection: (providerId?: string, modelId?: string) => ModelSelection;
}

interface PreferenceOverride {
  providerId: string;
  modelId: string;
}

export async function resolveSelectionWithPreferences(
  input: SelectionResolutionInput,
): Promise<ModelSelection> {
  const native = resolveNativeProviderSelection(input.providerConfigService, input.providerId, input.modelId);
  if (native) return input.resolveSelection(native.providerId, native.modelId);
  if (input.providerId !== undefined || input.modelId !== undefined) {
    return input.resolveSelection(input.providerId, input.modelId);
  }

  const preferenceOverride = await readPreferenceOverride(
    input.providerConfigService,
  );
  if (!preferenceOverride) {
    return input.resolveSelection(undefined, undefined);
  }

  return input.resolveSelection(
    preferenceOverride.providerId,
    preferenceOverride.modelId,
  );
}

/** Native admission pins precede request overrides and mutable preferences. */
export function resolveNativeProviderSelection(
  providerConfigService: Pick<SelectionProviderConfig, "getNativeProviderSelection" | "assertNativeProviderSelection"> | undefined,
  providerId?: string,
  modelId?: string,
): Readonly<PreferenceOverride> | null {
  const native = providerConfigService?.getNativeProviderSelection?.();
  if (!native) return null;
  if ((providerId !== undefined && providerId !== native.providerId) ||
      (modelId !== undefined && modelId !== native.modelId)) {
    throw new ValidationError("Native inference must retain its admitted provider and model.", "INVALID_PROVIDER_SELECTION");
  }
  providerConfigService?.assertNativeProviderSelection?.(native.providerId, native.modelId);
  return native;
}

async function readPreferenceOverride(
  providerConfigService?: SelectionProviderConfig,
): Promise<PreferenceOverride | null> {
  if (!providerConfigService) {
    return null;
  }

  try {
    const preferences = await providerConfigService.getPreferences();
    if (!preferences.defaultProviderId || !preferences.defaultModelId) {
      return null;
    }
    const providerConnected = await providerConfigService.isConnected(
      preferences.defaultProviderId,
    );
    if (!providerConnected) {
      console.warn(
        `[ai/preferences] Ignoring stale default provider preference (${preferences.defaultProviderId}); provider is not connected.`,
      );
      return null;
    }
    return {
      providerId: preferences.defaultProviderId,
      modelId: preferences.defaultModelId,
    };
  } catch (error) {
    console.warn(
      "[ai/preferences] Failed to load BYOK preferences; using adapter defaults",
      error,
    );
    return null;
  }
}
