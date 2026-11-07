import type {
  ProviderSettingsPort,
  ProviderSettingsCredential,
} from "@legioncode/client-ui";
import type { useProviderStore } from "../../hooks/useProviderStore";

function credentialId(credential: ProviderSettingsCredential): string {
  if (!credential.credentialId)
    throw new Error("The provider credential is unavailable.");
  return credential.credentialId;
}

/** Web retains its authenticated provider store and exact canonical credential IDs. */
export function providerSettingsAdapter(
  store: ReturnType<typeof useProviderStore>,
): ProviderSettingsPort {
  return {
    ...store,
    disconnectCredential: (credential) =>
      store.disconnectCredential(credentialId(credential)),
    validateCredential: (credential, mode) =>
      store.validateCredential(credentialId(credential), mode),
    applySessionSelection: (request) => {
      if (!request.credentialId)
        throw new Error("The provider credential is unavailable.");
      return store.applySessionSelection({
        ...request,
        credentialId: request.credentialId,
      });
    },
  };
}
