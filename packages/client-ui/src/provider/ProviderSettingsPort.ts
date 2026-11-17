import type {
  BYOKPreference,
  ProviderConnectionConfig,
  ProviderRegistryEntry,
} from "@repo/shared-types";
import type { ModelPickerModel } from "./modelPickerTypes.js";

/** Metadata only. Native credentials are identified by their actual provider;
 * hosted credentials additionally retain their canonical credential ID. */
export interface ProviderSettingsCredential {
  providerId: string;
  credentialId?: string;
  label?: string;
  keyFingerprint?: string;
  status?: string;
}
export type ProviderSettingsModel = ModelPickerModel & { provider?: string };
export const providerCredentialKey = (
  credential: ProviderSettingsCredential,
): string => credential.credentialId ?? credential.providerId;

export interface ProviderSettingsPort {
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  catalog: ProviderRegistryEntry[];
  credentials: ProviderSettingsCredential[];
  providerModels: Record<string, ProviderSettingsModel[]>;
  manageProviderModels: Record<string, ProviderSettingsModel[]>;
  visibleModelIds: Record<string, Set<string>>;
  loadingModelsForProviderId: string | null;
  loadingManageModelsForProviderIds: Record<string, boolean>;
  preferences: BYOKPreference | null;
  selectedProviderId: string | null;
  selectedCredentialId: string | null;
  selectedModelId: string | null;
  connectCredential(request: {
    providerId: string;
    secret: string;
    label?: string;
    config?: ProviderConnectionConfig;
  }): Promise<void>;
  disconnectCredential(credential: ProviderSettingsCredential): Promise<void>;
  validateCredential(
    credential: ProviderSettingsCredential,
    mode: "format" | "live",
  ): Promise<void>;
  loadProviderModels(providerId: string): Promise<ProviderSettingsModel[]>;
  loadManageProviderModels(
    providerId: string,
    limit?: number,
  ): Promise<ProviderSettingsModel[]>;
  applySessionSelection(request: {
    providerId: string;
    credentialId?: string;
    modelId?: string;
  }): Promise<unknown>;
  toggleModelVisibility(providerId: string, modelId: string): void;
  setProviderVisibleModels(providerId: string, modelIds: string[]): void;
  visibilityUnavailableReason?: string;
  credentialValidationUnavailableReason?: string;
}
