import {
  CredentialSecretSchema,
  projectRuntimeCredentialMaterial,
  type CredentialAcquisition,
  type CredentialSecret,
  type RuntimeCredentialMaterial,
  type ProviderConnectionConfig,
  type ProviderId,
} from "@repo/shared-types";
import type {
  CredentialConnectionStore,
  ProviderCredentialRecord,
  SqlClient,
} from "@repo/persistence";
import type { RunAttemptId, TurnId } from "@repo/platform-protocol";

export interface HarnessConnectionScope {
  userId: string;
  workspaceId: string;
}
export interface HarnessAttemptCredentialBinding extends HarnessConnectionScope {
  turnId: TurnId;
  runAttemptId: RunAttemptId;
  environmentId: string;
  connectionId: string;
  providerId: ProviderId;
  ownerGeneration: number;
}
/** Existing hosted/local authorization and admission owners implement these checks.
 * No browser claim or provider login authorizes a LegionCode user session here.
 */
export interface HarnessConnectionPolicy {
  authorize(scope: HarnessConnectionScope): Promise<void>;
  authorizeAttempt(
    binding: HarnessAttemptCredentialBinding,
    transaction?: SqlClient,
  ): Promise<void>;
  readonly signal?: AbortSignal;
  assertRouteAllowed(
    scope: HarnessConnectionScope,
    providerId: ProviderId,
    kind: CredentialSecret["type"],
  ): Promise<void>;
  fenceRevoked(
    scope: HarnessConnectionScope,
    connectionId: string,
    ownerGeneration: number,
  ): Promise<void>;
  ensureReady(): Promise<void>;
}
export interface HarnessConnectionMetadata {
  connectionId: string;
  providerId: ProviderId;
  ownerGeneration: number;
  tokenMaterialVersion: number;
  refreshPending: boolean;
  kind: CredentialSecret["type"];
  status: ProviderCredentialRecord["status"];
}

export interface HarnessRuntimeCredentialResolution {
  metadata: HarnessConnectionMetadata;
  secret: RuntimeCredentialMaterial;
}
/** Private custody delivery. Projection must be synchronous inside the authority
 * transaction; neither an SQL-backed port nor refresh material may escape it. */
export interface HarnessAttemptCredentialDeliveryPort {
  deliver(
    binding: HarnessAttemptCredentialBinding,
    expected: CredentialAcquisition,
    project: (
      record: ProviderCredentialRecord,
      secret: CredentialSecret,
    ) => HarnessRuntimeCredentialResolution | null,
  ): Promise<HarnessRuntimeCredentialResolution | null>;
}

/** External provider custody only; this does not implement app-session login. */
export class HarnessConnectionService {
  constructor(
    private readonly store: CredentialConnectionStore,
    private readonly policy: HarnessConnectionPolicy,
    private readonly delivery?: HarnessAttemptCredentialDeliveryPort,
  ) {}
  async create(
    scope: HarnessConnectionScope,
    input: {
      providerId: ProviderId;
      label: string;
      secret: CredentialSecret;
      connectionConfig?: ProviderConnectionConfig;
    },
  ): Promise<HarnessConnectionMetadata> {
    await this.authorize(scope);
    if (!input.label || input.label.length > 256)
      throw new Error("Invalid connection label");
    const parsed = CredentialSecretSchema.safeParse(input.secret);
    if (!parsed.success) throw new Error("Invalid credential material");
    await this.policy.assertRouteAllowed(
      scope,
      input.providerId,
      parsed.data.type,
    );
    const record = await this.store.createConnection({
      ...input,
      userId: scope.userId,
      secret: parsed.data,
    });
    return metadata(record);
  }
  async get(
    scope: HarnessConnectionScope,
    connectionId: string,
  ): Promise<HarnessConnectionMetadata | null> {
    await this.authorize(scope);
    const record = await this.store.getConnection(connectionId);
    return record && record.userId === scope.userId ? metadata(record) : null;
  }
  async assertUsableConnection(
    scope: HarnessConnectionScope,
    connectionId: string,
  ): Promise<HarnessConnectionMetadata | null> {
    await this.authorize(scope);
    const record = await this.store.getConnection(connectionId);
    if (
      !record ||
      record.userId !== scope.userId ||
      record.status !== "connected" ||
      record.deletedAt !== null
    )
      return null;
    await this.policy.assertRouteAllowed(
      scope,
      record.providerId,
      record.credentialKind,
    );
    return metadata(record);
  }

  /** Setup authorizes one exact custody snapshot, independently of any turn.
   * This does not authenticate a native process or authorize provider work. */
  async assertSetupAuthority(
    scope: HarnessConnectionScope,
    expected: HarnessConnectionMetadata,
  ): Promise<HarnessConnectionMetadata | null> {
    const selected = { ...expected };
    await this.authorize(scope);
    const record = await this.store.getConnection(selected.connectionId);
    if (
      !record ||
      record.credentialId !== selected.connectionId ||
      record.userId !== scope.userId ||
      record.providerId !== selected.providerId ||
      record.authOwnerGeneration !== selected.ownerGeneration ||
      record.tokenMaterialVersion !== selected.tokenMaterialVersion ||
      record.credentialKind !== selected.kind ||
      record.status !== "connected" ||
      selected.status !== "connected" ||
      record.deletedAt !== null ||
      record.refreshClaimId !== null ||
      selected.refreshPending
    )
      return null;
    await this.policy.assertRouteAllowed(
      scope,
      record.providerId,
      record.credentialKind,
    );
    return metadata(record);
  }

  async resolveForAttempt(binding: HarnessAttemptCredentialBinding) {
    binding = { ...binding };
    if (!this.delivery)
      throw new Error("Atomic harness credential delivery is unavailable");
    await this.policy.authorizeAttempt(binding);
    await this.policy.ensureReady();
    const before = await this.store.getConnection(binding.connectionId);
    if (
      !before ||
      before.userId !== binding.userId ||
      before.providerId !== binding.providerId ||
      before.authOwnerGeneration !== binding.ownerGeneration ||
      before.status !== "connected" ||
      before.deletedAt !== null ||
      before.refreshClaimId !== null
    )
      return null;
    await this.policy.assertRouteAllowed(
      binding,
      before.providerId,
      before.credentialKind,
    );
    // Preflight above captures CAS only. Delivery's transaction owns the final
    // admission + credential decision, decryption and synchronous projection.
    return this.delivery.deliver(
      binding,
      expected(before),
      (record, secret) => {
        if (secret.type === "oauth" && secret.expiresAt <= Date.now())
          return null;
        return {
          metadata: metadata(record),
          secret: projectRuntimeCredentialMaterial(secret),
        };
      },
    );
  }
  async refresh(
    scope: HarnessConnectionScope,
    connectionId: string,
    ownerGeneration: number,
    renew: (
      secret: Extract<CredentialSecret, { type: "oauth" }>,
    ) => Promise<Extract<CredentialSecret, { type: "oauth" }>>,
  ): Promise<HarnessConnectionMetadata | null> {
    await this.authorize(scope);
    const before = await this.store.getConnection(connectionId);
    if (
      !before ||
      before.userId !== scope.userId ||
      before.authOwnerGeneration !== ownerGeneration ||
      before.credentialKind !== "oauth"
    )
      return null;
    await this.policy.assertRouteAllowed(scope, before.providerId, "oauth");
    const claimed = await this.store.claimRefresh(expected(before));
    if (!claimed) return null;
    // An ambiguous refresh is never retried by releasing/stealing its durable claim.
    // Explicit reconnection is required if the provider outcome cannot be established.
    let secret: Extract<CredentialSecret, { type: "oauth" }>;
    try {
      secret = await renew(claimed.secret);
    } catch {
      throw new Error(
        "Credential refresh outcome is unavailable; reconnect explicitly",
      );
    }
    const record = await this.store.completeRefresh(claimed.claim, secret);
    return record ? metadata(record) : null;
  }
  async disconnect(
    scope: HarnessConnectionScope,
    connectionId: string,
    ownerGeneration: number,
  ): Promise<HarnessConnectionMetadata | null> {
    await this.authorize(scope);
    const before = await this.store.getConnection(connectionId);
    if (!before || before.userId !== scope.userId) return null;
    // Retrying an already durable revocation must retry any failed process fence too.
    const record =
      before.status === "revoked" &&
      before.authOwnerGeneration === ownerGeneration + 1
        ? before
        : await this.store.revokeConnection({
            ...expected(before),
            ownerGeneration,
          });
    if (!record) return null;
    await this.policy.fenceRevoked(
      scope,
      connectionId,
      record.authOwnerGeneration,
    );
    return metadata(record);
  }
  private async authorize(scope: HarnessConnectionScope): Promise<void> {
    if (!scope.userId || !scope.workspaceId)
      throw new Error("Credential authorization required");
    await this.policy.authorize(scope);
    await this.policy.ensureReady();
  }
}
function expected(r: ProviderCredentialRecord): CredentialAcquisition {
  return {
    connectionId: r.credentialId,
    userId: r.userId,
    providerId: r.providerId,
    ownerGeneration: r.authOwnerGeneration,
    tokenMaterialVersion: r.tokenMaterialVersion,
  };
}
function metadata(r: ProviderCredentialRecord): HarnessConnectionMetadata {
  return {
    connectionId: r.credentialId,
    providerId: r.providerId,
    ownerGeneration: r.authOwnerGeneration,
    tokenMaterialVersion: r.tokenMaterialVersion,
    refreshPending: r.refreshClaimId !== null,
    kind: r.credentialKind,
    status: r.status,
  };
}
