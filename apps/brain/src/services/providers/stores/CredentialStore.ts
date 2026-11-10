/**
 * Credential persistence contracts belong to the encrypted persistence owner.
 * Keep Brain consumers on that contract as connection custody evolves.
 */
export type {
  CredentialStore,
  ProviderCredentialRecord,
  SetCredentialInput,
} from "@repo/persistence";
