import { z } from "zod";
import {
  NativeProviderAdmissionRouteSchema,
  NativeProviderBindingSchema,
  NativeProviderBindingScopeSchema,
  PostgresCredentialStore,
  PostgresPreferenceStore,
  type NativeProviderAdmissionCapture,
} from "@repo/persistence";
import { CredentialAcquisitionSchema, ProviderIdSchema } from "@repo/shared-types";
import type { Env } from "../../types/ai";
import { captureNativeAxisMaterial } from "./NativeAxisCredentialMaterial";
import { ProviderRegistryService } from "./ProviderRegistryService";
import { getProviderEncryptionConfig } from "./stores/ProviderEncryptionConfig";

const ModelId = z.string().trim().min(1).max(256);
const CaptureInputSchema = z.object({
  scope: NativeProviderBindingScopeSchema,
  executionRoute: NativeProviderAdmissionRouteSchema,
  providerId: z.string().trim().min(1).max(256).nullable().optional(),
  modelId: ModelId.nullable().optional(),
}).strict().superRefine((input, context) => {
  if (input.executionRoute === "native" && (input.providerId != null) !== (input.modelId != null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Native admission requires a complete provider/model pair" });
  }
});

/** Private canonical admission producer. The caller supplies its original SQL
 * transaction and trusted placement route, never a renderer route assertion.
 * Its commit runs while both preference and credential metadata are fenced. */
export function createNativeProviderAdmissionCapture(env: Env): NativeProviderAdmissionCapture {
  const registry = new ProviderRegistryService();
  return {
    async withBinding(client, input, commit) {
      // Parse before any await so caller mutation cannot replace captured intent.
      const captured = CaptureInputSchema.parse(input);
      const scope = Object.freeze(captured.scope);
      if (captured.executionRoute === "delegated") return commit(client, null);
      // Existing adapter defaults are captured once; never persist its
      // "model-unset" sentinel as if it represented a selected model.
      const runtimeProvider = env.LLM_PROVIDER ?? "openai";
      const runtimeModel = env.DEFAULT_MODEL;
      return client.transaction(async (transaction) => {
        const preferences = new PostgresPreferenceStore(transaction, scope.userId, scope.workspaceId);
        const selected = await preferences.captureCredentialSelection();
        return preferences.withCredentialSelection(selected, async (boundClient) => {
          const current = await new PostgresPreferenceStore(boundClient, scope.userId, scope.workspaceId).getPreferences();
          let providerId: string;
          let modelId: string | undefined;
          if (captured.providerId != null && captured.modelId != null) {
            providerId = captured.providerId;
            modelId = captured.modelId;
          } else if (current.defaultProviderId && current.defaultModelId) {
            providerId = current.defaultProviderId;
            modelId = current.defaultModelId;
          } else {
            providerId = runtimeProvider;
            modelId = runtimeModel;
          }
          const provider = ProviderIdSchema.parse(providerId);
          const model = ModelId.parse(modelId);
          if (!registry.isProviderRegistered(provider) || model === "model-unset") throw unavailable();
          if (provider === "axis") {
            const material = await captureNativeAxisMaterial(env);
            const binding = NativeProviderBindingSchema.parse({
              v: 1, kind: "platform_managed_axis", scope, providerId: provider,
              modelId: model, materialFingerprint: material.materialFingerprint,
            });
            return commit(boundClient, binding);
          }
          const encryption = getProviderEncryptionConfig({
            BYOK_CREDENTIAL_ENCRYPTION_KEY: env.BYOK_CREDENTIAL_ENCRYPTION_KEY,
            BYOK_CREDENTIAL_ENCRYPTION_KEY_VERSION: env.BYOK_CREDENTIAL_ENCRYPTION_KEY_VERSION,
            BYOK_CREDENTIAL_ENCRYPTION_KEY_PREVIOUS: env.BYOK_CREDENTIAL_ENCRYPTION_KEY_PREVIOUS,
          });
          const credentials = new PostgresCredentialStore(boundClient, scope.userId, scope.workspaceId,
            encryption.masterKey, encryption.keyVersion, encryption.previousMasterKey);
          const connectionId = selected.providerId === provider ? selected.credentialId : undefined;
          const connection = await credentials.getConnectionForAdmission(provider, connectionId);
          if (!connection || connection.userId !== scope.userId || connection.workspaceId !== scope.workspaceId ||
              connection.providerId !== provider || (connectionId !== undefined && connection.credentialId !== connectionId) ||
              connection.status !== "connected" || connection.deletedAt !== null || connection.refreshClaimId !== null ||
              connection.credentialKind !== "api_key") throw unavailable();
          const credential = CredentialAcquisitionSchema.parse({
            connectionId: connection.credentialId, userId: scope.userId, providerId: provider,
            ownerGeneration: connection.authOwnerGeneration, tokenMaterialVersion: connection.tokenMaterialVersion,
          });
          const binding = NativeProviderBindingSchema.parse({
            v: 1, kind: "byok", scope, providerId: provider, modelId: model, credential,
          });
          return commit(boundClient, binding);
        });
      });
    },
  };
}

function unavailable(): Error {
  return new Error("Native admission requires an owned connected provider and a complete frozen selection");
}
