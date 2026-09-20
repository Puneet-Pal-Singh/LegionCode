import { describe, expect, it, expectTypeOf } from "vitest";
import {
  BYOKCredentialConnectRequestSchema,
  BYOKCredentialSchema,
  BYOKCredentialUpdateRequestSchema,
  BYOKCredentialValidateRequestSchema,
  BYOKCredentialValidateResponseSchema,
  BYOKDiscoveredProviderModelsQuerySchema,
  BYOKDiscoveredProviderModelsRefreshResponseSchema,
  BYOKDiscoveredProviderModelsResponseSchema,
  BYOKErrorCodeSchema,
  BYOKErrorEnvelopeSchema,
  BYOKErrorSchema,
  BYOKPreferenceSchema,
  BYOKPreferencesUpdateRequestSchema,
  BYOKResolutionSchema,
  BYOKResolveRequestSchema,
  ProviderRegistryEntrySchema,
  type BYOKCredential,
  type BYOKCredentialConnectRequest,
  type BYOKCredentialUpdateRequest,
  type BYOKCredentialValidateRequest,
  type BYOKCredentialValidateResponse,
  type BYOKDiscoveredProviderModelsQuery,
  type BYOKDiscoveredProviderModelsRefreshResponse,
  type BYOKDiscoveredProviderModelsResponse,
  type BYOKError,
  type BYOKErrorCode,
  type BYOKErrorEnvelope,
  type BYOKPreference,
  type BYOKPreferencesUpdateRequest,
  type BYOKResolution,
  type BYOKResolveRequest,
  type ProviderRegistryEntry,
} from "./types.js";
import {
  BYOKCredentialConnectRequestSchema as SharedBYOKCredentialConnectRequestSchema,
  BYOKCredentialSchema as SharedBYOKCredentialSchema,
  BYOKCredentialUpdateRequestSchema as SharedBYOKCredentialUpdateRequestSchema,
  BYOKCredentialValidateRequestSchema as SharedBYOKCredentialValidateRequestSchema,
  BYOKCredentialValidateResponseSchema as SharedBYOKCredentialValidateResponseSchema,
  BYOKDiscoveredProviderModelsQuerySchema as SharedBYOKDiscoveredProviderModelsQuerySchema,
  BYOKDiscoveredProviderModelsRefreshResponseSchema as SharedBYOKDiscoveredProviderModelsRefreshResponseSchema,
  BYOKDiscoveredProviderModelsResponseSchema as SharedBYOKDiscoveredProviderModelsResponseSchema,
  BYOKErrorCodeSchema as SharedBYOKErrorCodeSchema,
  BYOKErrorEnvelopeSchema as SharedBYOKErrorEnvelopeSchema,
  BYOKErrorSchema as SharedBYOKErrorSchema,
  BYOKPreferenceSchema as SharedBYOKPreferenceSchema,
  BYOKPreferencesUpdateRequestSchema as SharedBYOKPreferencesUpdateRequestSchema,
  BYOKResolutionSchema as SharedBYOKResolutionSchema,
  BYOKResolveRequestSchema as SharedBYOKResolveRequestSchema,
  type BYOKCredential as SharedBYOKCredential,
  type BYOKCredentialConnectRequest as SharedBYOKCredentialConnectRequest,
  type BYOKCredentialUpdateRequest as SharedBYOKCredentialUpdateRequest,
  type BYOKCredentialValidateRequest as SharedBYOKCredentialValidateRequest,
  type BYOKCredentialValidateResponse as SharedBYOKCredentialValidateResponse,
  type BYOKDiscoveredProviderModelsQuery as SharedBYOKDiscoveredProviderModelsQuery,
  type BYOKDiscoveredProviderModelsRefreshResponse as SharedBYOKDiscoveredProviderModelsRefreshResponse,
  type BYOKDiscoveredProviderModelsResponse as SharedBYOKDiscoveredProviderModelsResponse,
  type BYOKError as SharedBYOKError,
  type BYOKErrorCode as SharedBYOKErrorCode,
  type BYOKErrorEnvelope as SharedBYOKErrorEnvelope,
  type BYOKPreference as SharedBYOKPreference,
  type BYOKPreferencesUpdateRequest as SharedBYOKPreferencesUpdateRequest,
  type BYOKResolution as SharedBYOKResolution,
  type BYOKResolveRequest as SharedBYOKResolveRequest,
} from "@repo/shared-types";
import {
  ProviderRegistryEntrySchema as ProviderCoreProviderRegistryEntrySchema,
  type ProviderRegistryEntry as ProviderCoreProviderRegistryEntry,
} from "@repo/provider-core";

describe("provider contract parity", () => {
  it("re-exports canonical schemas from shared-types", () => {
    expect(BYOKCredentialSchema).toBe(SharedBYOKCredentialSchema);
    expect(BYOKCredentialConnectRequestSchema).toBe(
      SharedBYOKCredentialConnectRequestSchema,
    );
    expect(BYOKCredentialUpdateRequestSchema).toBe(
      SharedBYOKCredentialUpdateRequestSchema,
    );
    expect(BYOKCredentialValidateRequestSchema).toBe(
      SharedBYOKCredentialValidateRequestSchema,
    );
    expect(BYOKCredentialValidateResponseSchema).toBe(
      SharedBYOKCredentialValidateResponseSchema,
    );
    expect(BYOKDiscoveredProviderModelsQuerySchema).toBe(
      SharedBYOKDiscoveredProviderModelsQuerySchema,
    );
    expect(BYOKDiscoveredProviderModelsResponseSchema).toBe(
      SharedBYOKDiscoveredProviderModelsResponseSchema,
    );
    expect(BYOKDiscoveredProviderModelsRefreshResponseSchema).toBe(
      SharedBYOKDiscoveredProviderModelsRefreshResponseSchema,
    );
    expect(BYOKPreferenceSchema).toBe(SharedBYOKPreferenceSchema);
    expect(BYOKPreferencesUpdateRequestSchema).toBe(
      SharedBYOKPreferencesUpdateRequestSchema,
    );
    expect(BYOKResolutionSchema).toBe(SharedBYOKResolutionSchema);
    expect(BYOKResolveRequestSchema).toBe(SharedBYOKResolveRequestSchema);
    expect(BYOKErrorCodeSchema).toBe(SharedBYOKErrorCodeSchema);
    expect(BYOKErrorSchema).toBe(SharedBYOKErrorSchema);
    expect(BYOKErrorEnvelopeSchema).toBe(SharedBYOKErrorEnvelopeSchema);
    expect(ProviderRegistryEntrySchema).toBe(
      ProviderCoreProviderRegistryEntrySchema,
    );
  });

  it("keeps facade types assignable to shared-types definitions", () => {
    expectTypeOf<BYOKCredential>().toEqualTypeOf<SharedBYOKCredential>();
    expectTypeOf<BYOKCredentialConnectRequest>().toEqualTypeOf<SharedBYOKCredentialConnectRequest>();
    expectTypeOf<BYOKCredentialUpdateRequest>().toEqualTypeOf<SharedBYOKCredentialUpdateRequest>();
    expectTypeOf<BYOKCredentialValidateRequest>().toEqualTypeOf<SharedBYOKCredentialValidateRequest>();
    expectTypeOf<BYOKCredentialValidateResponse>().toEqualTypeOf<SharedBYOKCredentialValidateResponse>();
    expectTypeOf<BYOKDiscoveredProviderModelsQuery>().toEqualTypeOf<SharedBYOKDiscoveredProviderModelsQuery>();
    expectTypeOf<BYOKDiscoveredProviderModelsRefreshResponse>().toEqualTypeOf<SharedBYOKDiscoveredProviderModelsRefreshResponse>();
    expectTypeOf<BYOKDiscoveredProviderModelsResponse>().toEqualTypeOf<SharedBYOKDiscoveredProviderModelsResponse>();
    expectTypeOf<BYOKPreference>().toEqualTypeOf<SharedBYOKPreference>();
    expectTypeOf<BYOKPreferencesUpdateRequest>().toEqualTypeOf<SharedBYOKPreferencesUpdateRequest>();
    expectTypeOf<BYOKResolution>().toEqualTypeOf<SharedBYOKResolution>();
    expectTypeOf<BYOKResolveRequest>().toEqualTypeOf<SharedBYOKResolveRequest>();
    expectTypeOf<BYOKError>().toEqualTypeOf<SharedBYOKError>();
    expectTypeOf<BYOKErrorCode>().toEqualTypeOf<SharedBYOKErrorCode>();
    expectTypeOf<BYOKErrorEnvelope>().toEqualTypeOf<SharedBYOKErrorEnvelope>();
    expectTypeOf<ProviderRegistryEntry>().toEqualTypeOf<ProviderCoreProviderRegistryEntry>();
  });
});
