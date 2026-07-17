/**
 * Provider Type Definitions
 * UI-facing provider types.
 *
 * Transport contracts are canonical in @repo/shared-types and re-exported here
 * with provider-neutral names for web components/services.
 */

import type {
  BYOKConnectRequest as SharedConnectProviderRequest,
  BYOKConnectResponse as SharedConnectProviderResponse,
  BYOKDisconnectRequest as SharedDisconnectProviderRequest,
  BYOKDisconnectResponse as SharedDisconnectProviderResponse,
  BYOKPreferences as SharedProviderPreferences,
  BYOKPreferencesPatch as SharedProviderPreferencesPatch,
  ModelDescriptor as SharedModelDescriptor,
  ProviderConnection,
  ProviderId as SharedProviderId,
} from "@repo/shared-types";

export type ProviderId = SharedProviderId;
export type ModelDescriptor = SharedModelDescriptor;
export type ProviderConnectionStatus = ProviderConnection;
export type ConnectProviderRequest = SharedConnectProviderRequest;
export type ConnectProviderResponse = SharedConnectProviderResponse;
export type DisconnectProviderRequest = SharedDisconnectProviderRequest;
export type DisconnectProviderResponse = SharedDisconnectProviderResponse;
export type ProviderPreferences = SharedProviderPreferences;
export type ProviderPreferencesPatch = SharedProviderPreferencesPatch;

export interface ProviderConfig {
  providerId: ProviderId;
  status: "disconnected" | "connecting" | "connected" | "failed";
  lastValidatedAt?: string;
  defaultModel?: string;
  errorMessage?: string;
}

export interface SessionModelConfig {
  sessionId: string;
  providerId: ProviderId;
  modelId: string;
}
