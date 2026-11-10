import {
  CredentialSecretSchema,
  type CredentialAcquisition,
  type CredentialSecret,
} from "@repo/shared-types";
import type { ProviderCredentialRecord } from "./types.js";
import {
  CredentialEncryptionService,
  EncryptedSecretSchema,
} from "./credential-encryption.js";

export function acquisition(
  record: ProviderCredentialRecord,
): CredentialAcquisition {
  return {
    connectionId: record.credentialId,
    userId: record.userId,
    providerId: record.providerId,
    ownerGeneration: record.authOwnerGeneration,
    tokenMaterialVersion: record.tokenMaterialVersion,
  };
}
export function matches(
  record: ProviderCredentialRecord | null,
  expected: CredentialAcquisition,
): record is ProviderCredentialRecord {
  return (
    !!record &&
    record.credentialId === expected.connectionId &&
    record.userId === expected.userId &&
    record.providerId === expected.providerId &&
    record.authOwnerGeneration === expected.ownerGeneration &&
    record.tokenMaterialVersion === expected.tokenMaterialVersion &&
    record.status === "connected" &&
    record.deletedAt === null
  );
}
export function sameOAuthAccount(
  a: CredentialSecret,
  b: CredentialSecret,
): boolean {
  return (
    a.type === "oauth" &&
    b.type === "oauth" &&
    a.accountId === b.accountId &&
    a.issuer === b.issuer &&
    a.clientId === b.clientId &&
    JSON.stringify([...a.scopes].sort()) ===
      JSON.stringify([...b.scopes].sort())
  );
}
export class ConnectionSecretCodec {
  private readonly encryption = new CredentialEncryptionService();
  constructor(
    private readonly masterKey: string,
    private readonly keyVersion: string,
    private readonly previousMasterKey?: string,
  ) {}
  isLegacy(record: ProviderCredentialRecord): boolean {
    return (
      EncryptedSecretSchema.parse(JSON.parse(record.encryptedSecretJson))
        .contextVersion === undefined
    );
  }
  async encode(
    secret: CredentialSecret,
    record: ProviderCredentialRecord,
  ): Promise<string> {
    const parsed = CredentialSecretSchema.parse(secret);
    return JSON.stringify(
      await this.encryption.encrypt(JSON.stringify(parsed), {
        masterKey: this.masterKey,
        keyVersion: this.keyVersion,
        context: acquisition(record),
      }),
    );
  }
  async decode(
    record: ProviderCredentialRecord,
    allowLegacy = false,
  ): Promise<CredentialSecret> {
    const encrypted = EncryptedSecretSchema.parse(
      JSON.parse(record.encryptedSecretJson),
    );
    const legacy = encrypted.contextVersion === undefined;
    if (
      legacy &&
      (!allowLegacy ||
        record.credentialKind !== "api_key" ||
        !record.isDefault ||
        record.authOwnerGeneration !== 1 ||
        record.tokenMaterialVersion !== 1)
    )
      throw new Error("Credential migration required");
    const text = await this.encryption.decrypt(encrypted, {
      masterKey: this.masterKey,
      previousMasterKey: this.previousMasterKey,
      keyVersion: record.keyVersion,
      context: acquisition(record),
      allowLegacy,
    });
    const result = CredentialSecretSchema.parse(
      legacy ? { type: "api_key", apiKey: text } : JSON.parse(text),
    );
    if (result.type !== record.credentialKind)
      throw new Error("Credential kind mismatch");
    return result;
  }
}
