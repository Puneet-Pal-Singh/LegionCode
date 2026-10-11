import {
  BYOKConnectResponseSchema,
  BYOKDisconnectResponseSchema,
  BYOKValidateResponseSchema,
  type BYOKValidateResponse,
  type BYOKCredentialConnectRequest,
  type BYOKCredentialUpdateRequest,
  type BYOKCredentialValidateRequest,
} from "@repo/shared-types";
import { NotFoundError, ValidationError } from "../../domain/errors";
import { resolveBrainProviderProductPolicy } from "../../lib/provider-product-policy";
import { readProxyResponseJson } from "./ProviderRuntimeProxy";
import type { Env } from "../../types/ai";
import type { AuthorizedProviderScope } from "../../controllers/provider/ProviderAuthScopeService";
import {
  AXIS_PROVIDER_ID,
  canUseProviderAtRuntime,
  BYOKPreferencesSchema,
  type BYOKCredential,
  type ProviderProductPolicy,
  type ProviderConnection,
  type ProviderCatalogResponse,
} from "@repo/shared-types";
import {
  fetchRuntimeConnections,
  fetchRuntimePreferences,
  fetchRuntimeCatalog,
  proxyByokOperation,
} from "./ProviderRuntimeProxy";
type WorkspaceByokMetadata = { credentialLabels: Record<string, string> };

export async function loadConnectedCredentials(
  req: Request,
  env: Env,
  scope: AuthorizedProviderScope,
  correlationId: string,
  policy: ProviderProductPolicy,
): Promise<BYOKCredential[]> {
  const runtime = await fetchRuntimeConnections(req, env, scope, correlationId);
  const metadata = await loadWorkspaceByokMetadata(
    req,
    env,
    scope,
    correlationId,
  );
  const now = new Date().toISOString();
  const credentials: BYOKCredential[] = [];

  for (const connection of runtime.connections) {
    if (connection.status !== "connected") {
      continue;
    }
    if (!canUseProviderAtRuntime(policy, connection.providerId)) {
      continue;
    }

    const credentialId = buildVirtualCredentialId(connection.providerId);
    credentials.push({
      credentialId,
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      providerId: connection.providerId,
      label: resolveCredentialLabel(connection, credentialId, metadata),
      keyFingerprint: connection.keyFingerprint ?? "unavailable",
      encryptedSecretJson: "{}",
      keyVersion: "v2",
      status: connection.status,
      lastValidatedAt: connection.lastValidatedAt ?? null,
      lastErrorCode: connection.errorCode,
      lastErrorMessage: connection.errorMessage,
      createdAt: connection.lastValidatedAt ?? now,
      updatedAt: now,
      deletedAt: null,
    });
  }

  return credentials;
}

export function resolveCredentialLabel(
  connection: ProviderConnection,
  credentialId: string,
  metadata: WorkspaceByokMetadata,
): string {
  if (connection.providerId === AXIS_PROVIDER_ID) {
    return metadata.credentialLabels[credentialId] ?? "Axis (Free)";
  }
  return (
    metadata.credentialLabels[credentialId] ?? `${connection.providerId} key`
  );
}

export function buildVirtualCredentialId(providerId: string): string {
  const bytes = new Uint8Array(16);
  for (let index = 0; index < providerId.length; index += 1) {
    const code = providerId.charCodeAt(index);
    const position = index % 16;
    const current = bytes[position] ?? 0;
    bytes[position] = (current + code + index) & 0xff;
  }

  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

export async function configureDefaultPreferenceWhenAvailable(
  req: Request,
  env: Env,
  scope: AuthorizedProviderScope,
  providerId: string,
  correlationId: string,
): Promise<void> {
  const existingPreference = await fetchRuntimePreferences(
    req,
    env,
    scope,
    correlationId,
  );
  if (existingPreference.defaultProviderId) {
    return;
  }

  const catalog = await fetchRuntimeCatalog(req, env, scope, correlationId);
  const defaultModel = resolveOptionalDefaultModel(providerId, catalog);
  if (!defaultModel) {
    console.warn(
      `[provider/byok] ${correlationId} ${providerId}: connected without default model; catalog returned no selectable models`,
    );
    return;
  }

  const response = await proxyByokOperation(
    req,
    env,
    {
      scope,
      method: "PATCH",
      path: "/providers/preferences",
      body: {
        defaultProviderId: providerId,
        defaultModelId: defaultModel,
      },
    },
    BYOKPreferencesSchema,
    correlationId,
  );

  await readProxyResponseJson(response, BYOKPreferencesSchema, correlationId);
}

export function resolveOptionalDefaultModel(
  providerId: string,
  catalog: ProviderCatalogResponse,
): string | null {
  const provider = catalog.providers.find(
    (entry) => entry.providerId === providerId,
  );
  return provider?.defaultModelId ?? provider?.models[0]?.id ?? null;
}

export async function persistCredentialLabel(
  req: Request,
  env: Env,
  scope: AuthorizedProviderScope,
  credentialId: string,
  label: string,
  correlationId: string,
): Promise<void> {
  const response = await proxyByokOperation(
    req,
    env,
    {
      scope,
      method: "POST",
      path: "/providers/preferences/credential-labels",
      body: {
        credentialId,
        label,
      },
    },
    BYOKPreferencesSchema,
    correlationId,
  );

  await readProxyResponseJson(response, BYOKPreferencesSchema, correlationId);
}

export async function deleteCredentialLabel(
  req: Request,
  env: Env,
  scope: AuthorizedProviderScope,
  credentialId: string,
  correlationId: string,
): Promise<void> {
  const response = await proxyByokOperation(
    req,
    env,
    {
      scope,
      method: "DELETE",
      path: `/providers/preferences/credential-labels/${encodeURIComponent(credentialId)}`,
    },
    BYOKPreferencesSchema,
    correlationId,
  );

  await readProxyResponseJson(response, BYOKPreferencesSchema, correlationId);
}

export async function loadWorkspaceByokMetadata(
  req: Request,
  env: Env,
  scope: AuthorizedProviderScope,
  correlationId: string,
): Promise<WorkspaceByokMetadata> {
  const preferences = await fetchRuntimePreferences(
    req,
    env,
    scope,
    correlationId,
  );
  return {
    credentialLabels: preferences.credentialLabels ?? {},
  };
}

export async function listProviderCredentials(
  req: Request,
  env: Env,
  scope: AuthorizedProviderScope,
  correlationId: string,
) {
  const policy = resolveBrainProviderProductPolicy(env);
  const credentials = await loadConnectedCredentials(
    req,
    env,
    scope,
    correlationId,
    policy,
  );
  return credentials;
}

export async function connectProviderCredential(
  req: Request,
  env: Env,
  scope: AuthorizedProviderScope,
  correlationId: string,
  request: BYOKCredentialConnectRequest,
) {
  const policy = resolveBrainProviderProductPolicy(env);
  if (!canUseProviderAtRuntime(policy, request.providerId)) {
    throw new ValidationError(
      `Provider "${request.providerId}" is not available in this environment.`,
      "INVALID_PROVIDER_SELECTION",
      correlationId,
    );
  }

  const response = await proxyByokOperation(
    req,
    env,
    {
      scope,
      method: "POST",
      path: "/providers/connect",
      body: {
        providerId: request.providerId,
        apiKey: request.secret,
        config: request.config,
      },
    },
    BYOKConnectResponseSchema,
    correlationId,
  );

  await readProxyResponseJson(
    response,
    BYOKConnectResponseSchema,
    correlationId,
  );
  await configureDefaultPreferenceWhenAvailable(
    req,
    env,
    scope,
    request.providerId,
    correlationId,
  );

  const credentialId = buildVirtualCredentialId(request.providerId);
  if (request.label) {
    await persistCredentialLabel(
      req,
      env,
      scope,
      credentialId,
      request.label,
      correlationId,
    );
  }

  const credentials = await loadConnectedCredentials(
    req,
    env,
    scope,
    correlationId,
    policy,
  );
  const credential = credentials.find(
    (entry) => entry.providerId === request.providerId,
  );
  if (!credential) {
    throw new ValidationError(
      `Provider "${request.providerId}" did not return a connected credential.`,
      "PROVIDER_NOT_CONNECTED",
      correlationId,
    );
  }
  return credential;
}

export async function updateProviderCredential(
  req: Request,
  env: Env,
  scope: AuthorizedProviderScope,
  correlationId: string,
  credentialId: string,
  patch: BYOKCredentialUpdateRequest,
) {
  const policy = resolveBrainProviderProductPolicy(env);
  if (patch.label) {
    await persistCredentialLabel(
      req,
      env,
      scope,
      credentialId,
      patch.label,
      correlationId,
    );
  }

  const credentials = await loadConnectedCredentials(
    req,
    env,
    scope,
    correlationId,
    policy,
  );
  const credential = credentials.find(
    (entry) => entry.credentialId === credentialId,
  );
  if (!credential) {
    throw new NotFoundError(
      `Credential "${credentialId}" was not found.`,
      "CREDENTIAL_NOT_FOUND",
      correlationId,
    );
  }
  return credential;
}

export async function disconnectProviderCredential(
  req: Request,
  env: Env,
  scope: AuthorizedProviderScope,
  correlationId: string,
  credentialId: string,
) {
  const policy = resolveBrainProviderProductPolicy(env);
  const credentials = await loadConnectedCredentials(
    req,
    env,
    scope,
    correlationId,
    policy,
  );
  const credential = credentials.find(
    (entry) => entry.credentialId === credentialId,
  );
  if (!credential) {
    throw new NotFoundError(
      `Credential "${credentialId}" was not found.`,
      "CREDENTIAL_NOT_FOUND",
      correlationId,
    );
  }

  const response = await proxyByokOperation(
    req,
    env,
    {
      scope,
      method: "POST",
      path: "/providers/disconnect",
      body: { providerId: credential.providerId },
    },
    BYOKDisconnectResponseSchema,
    correlationId,
  );

  await readProxyResponseJson(
    response,
    BYOKDisconnectResponseSchema,
    correlationId,
  );
  await deleteCredentialLabel(req, env, scope, credentialId, correlationId);
}

export async function validateProviderCredential(
  req: Request,
  env: Env,
  scope: AuthorizedProviderScope,
  correlationId: string,
  credentialId: string,
  request: BYOKCredentialValidateRequest,
) {
  const policy = resolveBrainProviderProductPolicy(env);
  const credentials = await loadConnectedCredentials(
    req,
    env,
    scope,
    correlationId,
    policy,
  );
  const credential = credentials.find(
    (entry) => entry.credentialId === credentialId,
  );
  if (!credential) {
    throw new NotFoundError(
      `Credential "${credentialId}" was not found.`,
      "CREDENTIAL_NOT_FOUND",
      correlationId,
    );
  }

  const runtimeResponse = await proxyByokOperation(
    req,
    env,
    {
      scope,
      method: "POST",
      path: "/providers/validate",
      body: { providerId: credential.providerId, mode: request.mode },
    },
    BYOKValidateResponseSchema,
    correlationId,
  );
  const validated = await readProxyResponseJson<BYOKValidateResponse>(
    runtimeResponse,
    BYOKValidateResponseSchema,
    correlationId,
  );

  return {
    credentialId,
    valid: validated.status === "valid",
    validatedAt: validated.checkedAt,
  };
}
