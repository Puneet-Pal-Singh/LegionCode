export interface ProviderStoreScopeInput {
  runId: string;
  userId?: string;
  workspaceId?: string;
}

export interface ProviderRuntimeScopeInput {
  runId?: string;
  userId: string;
  workspaceId: string;
}

export const MAX_SCOPE_IDENTIFIER_LENGTH = 128;
export const SAFE_SCOPE_IDENTIFIER_REGEX = /^[A-Za-z0-9._:-]+$/;
