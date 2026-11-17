import { z } from "zod";
import { HarnessAdmissionSelectionSchema } from "@repo/platform-protocol";
import {
  CredentialAcquisitionSchema,
  CredentialSecretSchema,
  ProviderConnectionConfigSchema,
  ProviderIdSchema,
  type CredentialSecret,
} from "@repo/shared-types";
import type { ProviderCredentialRecord } from "@repo/persistence";

const reference = z.string().min(1).max(256);
const generation = z.number().int().safe().nonnegative();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const SelectedApiKeyRequestSchema = z
  .object({
    scope: z
      .object({
        userId: reference,
        workspaceId: reference,
        environmentId: reference,
        sessionId: reference,
        threadId: reference,
      })
      .strict()
      .readonly(),
    capture: HarnessAdmissionSelectionSchema,
    providerId: ProviderIdSchema,
    kind: z.literal("api_key"),
  })
  .strict()
  .readonly()
  .superRefine((input, context) => {
    if (
      input.scope.environmentId !== input.capture.environmentId ||
      !input.capture.selection ||
      !["codex", "opencode", "claude"].includes(
        input.capture.selection.harness,
      ) ||
      (input.capture.selection.harness === "codex" &&
        input.providerId !== "openai") ||
      (input.capture.selection.harness === "claude" &&
        input.providerId !== "anthropic")
    )
      context.addIssue({
        code: "custom",
        message: "An explicit supported selected API-key account is required",
      });
  });
export type SelectedApiKeyRequest = z.infer<typeof SelectedApiKeyRequestSchema>;

/** These generations come from locked durable owners, never labels or a first
 * runtime observation. P11 also validates the selected provider/model mapping. */
export const LockedSelectedApiKeySchema = z
  .object({
    request: SelectedApiKeyRequestSchema,
    instanceAuthOwnerGeneration: generation,
    credential: CredentialAcquisitionSchema.readonly(),
  })
  .strict()
  .readonly();
export type LockedSelectedApiKey = z.infer<typeof LockedSelectedApiKeySchema>;

export const SelectedApiKeyProvenanceSchema = z
  .object({
    request: SelectedApiKeyRequestSchema,
    instanceAuthOwnerGeneration: generation,
    credential: CredentialAcquisitionSchema.readonly(),
    fingerprintScheme: z.enum([
      "codex-selected-api-key-0.167.0",
      "legioncode-selected-api-key-v1",
    ]),
    identityFingerprint: sha256,
    // Private raw-key proof for native guards; not the identity fingerprint.
    keyMaterialSha256: sha256,
    connectionConfigFingerprint: sha256,
  })
  .strict()
  .readonly();
export type SelectedApiKeyProvenance = z.infer<
  typeof SelectedApiKeyProvenanceSchema
>;

export function assertSelectedApiKeyRecord(
  selected: LockedSelectedApiKey,
  record: ProviderCredentialRecord | null,
): asserts record is ProviderCredentialRecord {
  const { request, credential } = selected;
  if (
    !record ||
    !request.capture.selection ||
    credential.userId !== request.scope.userId ||
    credential.providerId !== request.providerId ||
    credential.connectionId !== request.capture.selection.connectionId ||
    record.userId !== request.scope.userId ||
    record.credentialId !== credential.connectionId ||
    record.providerId !== credential.providerId ||
    record.authOwnerGeneration !== credential.ownerGeneration ||
    record.tokenMaterialVersion !== credential.tokenMaterialVersion ||
    record.credentialKind !== "api_key" ||
    record.status !== "connected" ||
    record.deletedAt !== null ||
    record.refreshClaimId !== null
  )
    throw unavailable();
}

/** Private metadata only. No account ID is fabricated for Codex's ApiKey {}.
 * Fingerprints are not authentication, entitlement or host qualification. */
export async function projectSelectedApiKeyProvenance(
  selected: LockedSelectedApiKey,
  record: ProviderCredentialRecord,
  secret: CredentialSecret,
): Promise<SelectedApiKeyProvenance> {
  assertSelectedApiKeyRecord(selected, record);
  const { apiKey } = CredentialSecretSchema.options[0].parse(secret);
  if (
    apiKey.trim() !== apiKey ||
    Array.from(apiKey).some((character) => character.trim() === "") ||
    apiKey.includes(String.fromCharCode(0)) ||
    apiKey.includes("{") ||
    apiKey.includes("}") ||
    apiKey.includes("[") ||
    apiKey.includes("]") ||
    apiKey.includes(String.fromCharCode(34))
  )
    throw unavailable();
  const configuration =
    record.connectionConfig === undefined
      ? null
      : ProviderConnectionConfigSchema.parse(record.connectionConfig);
  if (
    configuration &&
    (configuration.providerId !== selected.request.providerId ||
      selected.request.capture.selection?.harness === "codex" ||
      selected.request.capture.selection?.harness === "claude")
  )
    throw unavailable();
  const codex = selected.request.capture.selection?.harness === "codex";
  // Byte-for-byte Node-free equivalent of the pinned Codex helper. OpenCode's
  // private vault fingerprint does not claim native sourceConnection/payer proof.
  const identity = codex
    ? { source: "codex-selected-api-key-0.167.0", apiKey }
    : {
        source: "legioncode-selected-api-key-v1",
        providerId: selected.request.providerId,
        apiKey,
      };
  const identityFingerprint = await digest(JSON.stringify(identity));
  // Same authorized acquisition and held tuple as the identity/config proofs.
  // Never obtain key material again to populate a native guard binding.
  const keyMaterialSha256 = await digest(apiKey);
  const connectionConfigFingerprint = await digest(
    JSON.stringify({
      source: "legioncode-selected-provider-config-v1",
      configuration,
    }),
  );
  return SelectedApiKeyProvenanceSchema.parse({
    ...selected,
    fingerprintScheme: codex
      ? "codex-selected-api-key-0.167.0"
      : "legioncode-selected-api-key-v1",
    identityFingerprint,
    keyMaterialSha256,
    connectionConfigFingerprint,
  });
}

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  try {
    return Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
  } finally {
    bytes.fill(0);
  }
}
export function unavailable(): Error {
  return new Error("Selected API-key custody is unavailable");
}
