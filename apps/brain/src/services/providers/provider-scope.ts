/**
 * Provider scope helpers.
 *
 * Single Responsibility: Normalize provider credential scope values for
 * storage key generation and migration compatibility.
 */

import type { ProviderRuntimeScopeInput } from "../../types/provider-scope";
export type { ProviderStoreScopeInput } from "../../types/provider-scope";

export interface ProviderStoreScope {
  runId?: string;
  userId: string;
  workspaceId: string;
  usedDerivedUserScope: boolean;
  usedDerivedWorkspaceScope: boolean;
}

export function normalizeProviderScope(
  scope: ProviderRuntimeScopeInput,
): ProviderStoreScope {
  const userId = normalizeIdentifier(scope.userId);
  const workspaceId = normalizeIdentifier(scope.workspaceId);

  return {
    runId: scope.runId,
    userId,
    workspaceId,
    usedDerivedUserScope: false,
    usedDerivedWorkspaceScope: false,
  };
}

export function sanitizeScopeSegment(value: string): string {
  return encodeURIComponent(value);
}

function normalizeIdentifier(value: string): string {
  return value.trim();
}
