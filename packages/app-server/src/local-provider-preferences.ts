import { LOCAL_USER_ID } from "./local-threads.js";
import {
  LocalProviderPreferenceScopeSchema,
  type LocalProviderPreferenceScope,
} from "./protocol.js";
import {
  BYOKPreferenceSchema,
  BYOKPreferencesUpdateRequestSchema,
  type BYOKPreference,
  type BYOKPreferencesUpdateRequest,
} from "@repo/shared-types";
import { ProviderIdSchema, type LocalWorkspaceGrant, type WorkspaceId } from "@repo/platform-protocol";
import type { LocalProviderService } from "./local-providers.js";

export interface LocalProviderPreferencesOptions {
  getWorkspace(): Promise<LocalWorkspaceGrant | null>;
  store: {
    read(workspaceId: WorkspaceId): Promise<unknown | null>;
    write(workspaceId: WorkspaceId, preferences: unknown): Promise<void>;
  };
  providers: Pick<LocalProviderService, "listCatalog" | "getModel">;
}

/** Canonical workspace-scoped preferences; never credentials or runtime resolution. */
export class LocalProviderPreferences {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly options: LocalProviderPreferencesOptions) {}
  read(
    runId: string | undefined,
    scope?: LocalProviderPreferenceScope,
  ): Promise<BYOKPreference> {
    return this.withGrant(runId, scope, async (grant) =>
      this.readCurrent(grant),
    );
  }
  update(
    runId: string | undefined,
    input: BYOKPreferencesUpdateRequest,
    scope?: LocalProviderPreferenceScope,
  ): Promise<BYOKPreference> {
    return this.withGrant(runId, scope, async (grant) => {
      const patch = BYOKPreferencesUpdateRequestSchema.parse(input);
      const current = await this.readCurrent(grant);
      const next = BYOKPreferenceSchema.parse({
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
      });
      await this.validateModels(next);
      await this.assertCurrent(grant);
      await this.options.store.write(grant.workspaceId, next);
      return next;
    });
  }
  private withGrant<T>(
    runId: string | undefined,
    inputScope: LocalProviderPreferenceScope | undefined,
    operation: (grant: LocalWorkspaceGrant) => Promise<T>,
  ): Promise<T> {
    if (runId !== undefined)
      return Promise.reject(
        new Error(
          "Local provider preferences require the current granted workspace",
        ),
      );
    const expected = LocalProviderPreferenceScopeSchema.safeParse(inputScope);
    if (!expected.success)
      return Promise.reject(
        new Error(
          "Local provider preferences require an explicit workspace grant scope",
        ),
      );
    const captured = this.requireWorkspace();
    const result = Promise.allSettled([this.queue, captured] as const).then(
      async ([, grant]) => {
        if (grant.status === "rejected") throw grant.reason;
        if (
          grant.value.workspaceId !== expected.data.workspaceId ||
          grant.value.grantedAt !== expected.data.grantedAt
        )
          throw new Error(
            "Workspace grant changed before provider preferences operation",
          );
        await this.assertCurrent(grant.value);
        const value = await operation(grant.value);
        await this.assertCurrent(grant.value);
        return value;
      },
    );
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  private async readCurrent(
    grant: LocalWorkspaceGrant,
  ): Promise<BYOKPreference> {
    const stored = await this.options.store.read(grant.workspaceId);
    const preference = BYOKPreferenceSchema.parse(
      stored ?? {
        userId: LOCAL_USER_ID,
        workspaceId: grant.workspaceId,
        visibleModelIds: {},
        updatedAt: new Date().toISOString(),
      },
    );
    if (
      preference.workspaceId !== grant.workspaceId ||
      preference.userId !== LOCAL_USER_ID ||
      preference.defaultCredentialId !== undefined
    )
      throw new Error("Stored provider preferences identity is invalid");
    await this.validateModels(preference);
    await this.assertCurrent(grant);
    if (stored === null)
      await this.options.store.write(grant.workspaceId, preference);
    return preference;
  }
  private async validateModels(preference: BYOKPreference): Promise<void> {
    const providers = new Set(
      this.options.providers.listCatalog().map((entry) => entry.providerId),
    );
    if (Object.keys(preference.visibleModelIds).length > 64)
      throw new Error("Too many provider visibility records");
    for (const [providerId, models] of Object.entries(
      preference.visibleModelIds,
    )) {
      if (
        !providers.has(providerId) ||
        models.length > 512 ||
        new Set(models).size !== models.length
      )
        throw new Error("Provider model visibility is invalid");
      const id = ProviderIdSchema.parse(providerId);
      const declared = await Promise.all(models.map((model) => this.options.providers.getModel(id, model)));
      if (declared.some((model) => model === null))
        throw new Error("Provider model visibility names an unavailable model");
    }
    if (
      preference.defaultProviderId &&
      !providers.has(preference.defaultProviderId)
    )
      throw new Error("Default provider is unavailable");
    if (preference.defaultModelId) {
      if (!preference.defaultProviderId || !await this.options.providers.getModel(
        ProviderIdSchema.parse(preference.defaultProviderId), preference.defaultModelId,
      )) throw new Error("Default provider model is unavailable");
    }
  }
  private async requireWorkspace(): Promise<LocalWorkspaceGrant> {
    const grant = await this.options.getWorkspace();
    if (!grant || grant.readiness !== "ready")
      throw new Error(
        "A ready local workspace is required for provider preferences",
      );
    return grant;
  }
  private async assertCurrent(expected: LocalWorkspaceGrant): Promise<void> {
    const current = await this.requireWorkspace();
    if (
      current.workspaceId !== expected.workspaceId ||
      current.grantedAt !== expected.grantedAt
    )
      throw new Error(
        "Workspace grant changed during provider preferences operation",
      );
  }
}
