import { ValidationError } from "../../../domain/errors";

export interface ProviderEncryptionConfig {
  masterKey: string;
  keyVersion: string;
  previousKeyVersion: string | undefined;
}

export function getProviderEncryptionConfig(
  env: Record<string, unknown>,
): ProviderEncryptionConfig {
  const masterKey = env.BYOK_CREDENTIAL_ENCRYPTION_KEY as string | undefined;
  const keyVersion =
    (env.BYOK_CREDENTIAL_ENCRYPTION_KEY_VERSION as string) || "v1";
  const previousKeyVersion =
    env.BYOK_CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_VERSION as string | undefined;

  if (!masterKey) {
    throw new ValidationError(
      "Missing dedicated BYOK credential encryption key",
      "BYOK_ENCRYPTION_KEY_MISSING",
    );
  }

  return {
    masterKey,
    keyVersion,
    previousKeyVersion,
  };
}
