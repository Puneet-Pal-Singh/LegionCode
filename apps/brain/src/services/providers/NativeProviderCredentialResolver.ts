import {
  parseNativeProviderBindingForAdmission,
  type CredentialConnectionStore,
  type NativeProviderBinding,
  type NativeProviderBindingScope,
} from "@repo/persistence";
import {
  CredentialSecretSchema,
  ProviderConnectionConfigSchema,
  type ProviderConnectionConfig,
  type ProviderId,
} from "@repo/shared-types";
import type { Env } from "../../types/ai";
import {
  acquireNativeAxisMaterial,
  type NativeAxisCredentialMaterial,
} from "./NativeAxisCredentialMaterial";

export interface NativeProviderCredentialContext {
  readonly binding: unknown;
  readonly scope: NativeProviderBindingScope;
}

interface NativeProviderRuntimeCredential {
  readonly apiKey: string;
  readonly connectionConfig?: ProviderConnectionConfig;
}

/** Acquire only the admitted payer and material version, never current defaults. */
export class NativeProviderCredentialResolver {
  private readonly binding: NativeProviderBinding;
  private readonly credentials: Pick<CredentialConnectionStore, "acquireConnection">;
  private readonly env: Env;

  constructor(options: {
    readonly context: NativeProviderCredentialContext;
    readonly credentials: Pick<CredentialConnectionStore, "acquireConnection">;
    readonly env: Env;
  }) {
    const binding = parseNativeProviderBindingForAdmission(options.context.binding, options.context.scope);
    Object.freeze(binding.scope);
    if (binding.kind === "byok") Object.freeze(binding.credential);
    this.binding = Object.freeze(binding);
    this.credentials = options.credentials;
    this.env = options.env;
  }

  get providerId(): ProviderId { return this.binding.providerId; }
  get modelId(): string { return this.binding.modelId; }

  assertSelection(providerId: string, modelId: string): void {
    if (providerId !== this.providerId || modelId !== this.modelId) throw unavailable();
  }

  async resolveCredential(providerId: ProviderId): Promise<NativeProviderRuntimeCredential> {
    if (providerId !== this.providerId) throw unavailable();
    const binding = this.binding;
    if (binding.kind === "platform_managed_axis") {
      const material = await acquireNativeAxisMaterial(this.env, binding.materialFingerprint);
      return { apiKey: material.apiKey };
    }
    const acquired = await this.credentials.acquireConnection(binding.credential);
    if (!acquired) throw unavailable();
    const { record } = acquired;
    const expected = binding.credential;
    if (record.userId !== binding.scope.userId || record.workspaceId !== binding.scope.workspaceId ||
        record.providerId !== binding.providerId || record.credentialId !== expected.connectionId ||
        record.authOwnerGeneration !== expected.ownerGeneration || record.tokenMaterialVersion !== expected.tokenMaterialVersion ||
        record.status !== "connected" || record.deletedAt !== null || record.refreshClaimId !== null ||
        record.credentialKind !== "api_key") throw unavailable();
    const secret = CredentialSecretSchema.parse(acquired.secret);
    if (secret.type !== "api_key") throw unavailable();
    const connectionConfig = record.connectionConfig === undefined
      ? undefined : ProviderConnectionConfigSchema.parse(record.connectionConfig);
    if (connectionConfig && connectionConfig.providerId !== binding.providerId) throw unavailable();
    return { apiKey: secret.apiKey, ...(connectionConfig ? { connectionConfig } : {}) };
  }

  /** Internal structured-generation port; bypasses no public Axis key policy. */
  async resolveManagedAxisMaterial(providerId: ProviderId): Promise<NativeAxisCredentialMaterial | null> {
    if (providerId !== this.providerId) throw unavailable();
    if (this.binding.kind !== "platform_managed_axis") return null;
    return acquireNativeAxisMaterial(this.env, this.binding.materialFingerprint);
  }
}

function unavailable(): Error {
  return new Error("Native provider credentials do not match the admitted binding");
}
