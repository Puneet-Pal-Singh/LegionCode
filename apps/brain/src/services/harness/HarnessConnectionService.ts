import {
  CredentialSecretSchema,
  type CredentialAcquisition,
  type CredentialSecret,
  type ProviderConnectionConfig,
  type ProviderId,
} from "@repo/shared-types";
import type {
  CredentialConnectionStore,
  ProviderCredentialRecord,
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
  authorizeAttempt(binding: HarnessAttemptCredentialBinding): Promise<void>;
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

/** External provider custody only; this does not implement app-session login. */
export class HarnessConnectionService {
  constructor(
    private readonly store: CredentialConnectionStore,
    private readonly policy: HarnessConnectionPolicy,
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

  async resolveForAttempt(binding: HarnessAttemptCredentialBinding) {
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
    const acquired = await this.store.acquireConnection(expected(before));
    if (!acquired) return null;
    // Decryption/storage I/O can outlive Stop or an execution-claim fence. The
    // encrypted store checks credential CAS; the admission owner must separately
    // revalidate the attempt before any material leaves this custody boundary.
    await this.policy.authorizeAttempt(binding);
    const current = await this.store.getConnection(binding.connectionId);
    if (
      !current ||
      current.credentialId !== acquired.record.credentialId ||
      current.userId !== binding.userId ||
      current.providerId !== binding.providerId ||
      current.authOwnerGeneration !== binding.ownerGeneration ||
      current.tokenMaterialVersion !== acquired.record.tokenMaterialVersion ||
      current.credentialKind !== acquired.secret.type ||
      current.status !== "connected" ||
      current.deletedAt !== null ||
      current.refreshClaimId !== null
    )
      return null;
    // Long-lived refresh material never crosses the harness resolver port.
    if (acquired.secret.type === "oauth") {
      const { refreshToken: _, ...secret } = acquired.secret;
      if (secret.expiresAt <= Date.now()) return null;
      return { metadata: metadata(current), secret };
    }
    return { metadata: metadata(current), secret: acquired.secret };
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
