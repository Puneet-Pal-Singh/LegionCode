import { describe, expect, it, expectTypeOf } from "vitest";
import {
  BUILTIN_PROVIDERS,
  ModelDescriptorSchema,
  PROVIDER_IDS,
  ProviderAdapterFamilySchema,
  ProviderCapabilityFlagsSchema,
  ProviderCatalogEntrySchema,
  ProviderCatalogResponseSchema,
  ProviderConnectionSchema,
  ProviderConnectionStateSchema,
  ProviderConnectionsResponseSchema,
  ProviderErrorCodeSchema,
  ProviderIdSchema,
  ProviderRegistryEntrySchema,
  ProviderRegistrySchema,
  ProviderValidationAuthModeSchema,
  findBuiltinProvider,
  getKnownProviderIds,
  isKnownProvider,
  getBuiltinRegistry,
  type ProviderAdapterFamily,
  type ProviderCapabilityFlags,
  type ModelDescriptor,
  type ProviderCatalogEntry,
  type ProviderCatalogResponse,
  type ProviderConnection,
  type ProviderConnectionState,
  type ProviderConnectionsResponse,
  type ProviderErrorCode,
  type ProviderId,
  type ProviderRegistryEntry,
  type ProviderRegistrySnapshot,
  type ProviderValidationAuthMode,
} from "./index.js";
import {
  BUILTIN_PROVIDERS as SharedBUILTIN_PROVIDERS,
  ModelDescriptorSchema as SharedModelDescriptorSchema,
  PROVIDER_IDS as SharedPROVIDER_IDS,
  ProviderAdapterFamilySchema as SharedProviderAdapterFamilySchema,
  ProviderCapabilityFlagsSchema as SharedProviderCapabilityFlagsSchema,
  ProviderCatalogEntrySchema as SharedProviderCatalogEntrySchema,
  ProviderCatalogResponseSchema as SharedProviderCatalogResponseSchema,
  ProviderConnectionSchema as SharedProviderConnectionSchema,
  ProviderConnectionStateSchema as SharedProviderConnectionStateSchema,
  ProviderConnectionsResponseSchema as SharedProviderConnectionsResponseSchema,
  ProviderErrorCodeSchema as SharedProviderErrorCodeSchema,
  ProviderIdSchema as SharedProviderIdSchema,
  ProviderRegistryEntrySchema as SharedProviderRegistryEntrySchema,
  ProviderRegistrySchema as SharedProviderRegistrySchema,
  ProviderValidationAuthModeSchema as SharedProviderValidationAuthModeSchema,
  findBuiltinProvider as SharedFindBuiltinProvider,
  getKnownProviderIds as SharedGetKnownProviderIds,
  isKnownProvider as SharedIsKnownProvider,
  getBuiltinRegistry as SharedGetBuiltinRegistry,
  type ProviderAdapterFamily as SharedProviderAdapterFamily,
  type ProviderCapabilityFlags as SharedProviderCapabilityFlags,
  type ModelDescriptor as SharedModelDescriptor,
  type ProviderCatalogEntry as SharedProviderCatalogEntry,
  type ProviderCatalogResponse as SharedProviderCatalogResponse,
  type ProviderConnection as SharedProviderConnection,
  type ProviderConnectionState as SharedProviderConnectionState,
  type ProviderConnectionsResponse as SharedProviderConnectionsResponse,
  type ProviderErrorCode as SharedProviderErrorCode,
  type ProviderId as SharedProviderId,
  type ProviderRegistryEntry as SharedProviderRegistryEntry,
  type ProviderRegistry as SharedProviderRegistry,
  type ProviderValidationAuthMode as SharedProviderValidationAuthMode,
} from "@repo/shared-types";

describe("provider-core contract parity", () => {
  it("re-exports canonical provider contract schemas", () => {
    expect(ProviderIdSchema).toBe(SharedProviderIdSchema);
    expect(ProviderCapabilityFlagsSchema).toBe(
      SharedProviderCapabilityFlagsSchema,
    );
    expect(ModelDescriptorSchema).toBe(SharedModelDescriptorSchema);
    expect(ProviderCatalogEntrySchema).toBe(SharedProviderCatalogEntrySchema);
    expect(ProviderCatalogResponseSchema).toBe(SharedProviderCatalogResponseSchema);
    expect(ProviderConnectionStateSchema).toBe(
      SharedProviderConnectionStateSchema,
    );
    expect(ProviderConnectionSchema).toBe(SharedProviderConnectionSchema);
    expect(ProviderConnectionsResponseSchema).toBe(
      SharedProviderConnectionsResponseSchema,
    );
    expect(ProviderErrorCodeSchema).toBe(SharedProviderErrorCodeSchema);
    expect(ProviderAdapterFamilySchema).toBe(SharedProviderAdapterFamilySchema);
    expect(ProviderValidationAuthModeSchema).toBe(
      SharedProviderValidationAuthModeSchema,
    );
    expect(ProviderRegistryEntrySchema).toBe(SharedProviderRegistryEntrySchema);
    expect(ProviderRegistrySchema).toBe(SharedProviderRegistrySchema);
    expect(PROVIDER_IDS).toBe(SharedPROVIDER_IDS);
    expect(BUILTIN_PROVIDERS).toBe(SharedBUILTIN_PROVIDERS);
    expect(findBuiltinProvider).toBe(SharedFindBuiltinProvider);
    expect(isKnownProvider).toBe(SharedIsKnownProvider);
    expect(getKnownProviderIds).toBe(SharedGetKnownProviderIds);
    expect(getBuiltinRegistry).toBe(SharedGetBuiltinRegistry);
  });

  it("keeps provider contract types equal to shared-types", () => {
    expectTypeOf<ProviderId>().toEqualTypeOf<SharedProviderId>();
    expectTypeOf<ProviderCapabilityFlags>().toEqualTypeOf<SharedProviderCapabilityFlags>();
    expectTypeOf<ProviderAdapterFamily>().toEqualTypeOf<SharedProviderAdapterFamily>();
    expectTypeOf<ProviderValidationAuthMode>().toEqualTypeOf<SharedProviderValidationAuthMode>();
    expectTypeOf<ModelDescriptor>().toEqualTypeOf<SharedModelDescriptor>();
    expectTypeOf<ProviderCatalogEntry>().toEqualTypeOf<SharedProviderCatalogEntry>();
    expectTypeOf<ProviderCatalogResponse>().toEqualTypeOf<SharedProviderCatalogResponse>();
    expectTypeOf<ProviderConnectionState>().toEqualTypeOf<SharedProviderConnectionState>();
    expectTypeOf<ProviderConnection>().toEqualTypeOf<SharedProviderConnection>();
    expectTypeOf<ProviderConnectionsResponse>().toEqualTypeOf<SharedProviderConnectionsResponse>();
    expectTypeOf<ProviderErrorCode>().toEqualTypeOf<SharedProviderErrorCode>();
    expectTypeOf<ProviderRegistryEntry>().toEqualTypeOf<SharedProviderRegistryEntry>();
    expectTypeOf<ProviderRegistrySnapshot>().toEqualTypeOf<SharedProviderRegistry>();
  });
});
