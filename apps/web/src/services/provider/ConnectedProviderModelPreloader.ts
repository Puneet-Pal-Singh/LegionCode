import type { BYOKCredential, ProviderRegistryEntry } from "@repo/shared-types";

interface ConnectedProviderModelPreloaderInput {
  readonly catalog: readonly ProviderRegistryEntry[];
  readonly credentials: readonly BYOKCredential[];
  readonly loadPickerModels: (providerId: string) => Promise<unknown>;
  readonly loadManageModels: (providerId: string) => Promise<unknown>;
  readonly isCurrent: () => boolean;
}

/**
 * Warms both picker and management projections for every connected provider.
 * ProviderStore remains the state owner; this helper only coordinates startup
 * hydration without making the store bootstrap wait on inference APIs.
 */
export async function preloadConnectedProviderModels(
  input: ConnectedProviderModelPreloaderInput,
): Promise<void> {
  const visibleProviders = new Set(
    input.catalog.map((provider) => provider.providerId),
  );
  const connectedProviderIds = [
    ...new Set(
      input.credentials
        .filter(
          (credential) =>
            credential.status === "connected" &&
            credential.deletedAt === null &&
            visibleProviders.has(credential.providerId),
        )
        .map((credential) => credential.providerId),
    ),
  ];

  await Promise.allSettled(
    connectedProviderIds.map(async (providerId) => {
      if (!input.isCurrent()) {
        return;
      }
      // Prioritize the picker and let the management request reuse the
      // provider cache instead of racing two cold inference API requests.
      await Promise.allSettled([input.loadPickerModels(providerId)]);
      if (!input.isCurrent()) {
        return;
      }
      await input.loadManageModels(providerId);
    }),
  );
}
