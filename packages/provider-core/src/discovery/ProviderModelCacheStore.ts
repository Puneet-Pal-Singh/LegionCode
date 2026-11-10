/**
 * Provider Model Cache Store Interface
 *
 * Focused interface for provider model discovery cache.
 * Supports both global (provider-wide) and user-scoped (per-credential) caching.
 */

import type {
  BYOKDiscoveredProviderModel,
  BYOKModelDiscoverySource,
} from "@repo/shared-types";

export interface ProviderModelCacheRecord {
  providerId: string;
  models: BYOKDiscoveredProviderModel[];
  fetchedAt: string;
  expiresAt: string;
  source: BYOKModelDiscoverySource;
}

export interface UserScopedCacheKey {
  providerId: string;
  credentialId: string;
}

export interface ProviderModelCacheStore {
  /**
   * Get cached models for a provider (global/shared cache)
   */
  getModelCache(providerId: string): Promise<ProviderModelCacheRecord | null>;

  /**
   * Set model cache for a provider (global/shared cache)
   */
  setModelCache(record: ProviderModelCacheRecord): Promise<void>;

  /**
   * Invalidate cache for a provider (global/shared cache)
   */
  invalidateModelCache(providerId: string): Promise<void>;

  /**
   * Get cached user-scoped models (e.g., /models/user endpoint)
   * Returns null if not cached or cache expired
   */
  getUserModelCache(
    key: UserScopedCacheKey,
  ): Promise<ProviderModelCacheRecord | null>;

  /**
   * Set user-scoped model cache (e.g., /models/user endpoint)
   */
  setUserModelCache(
    key: UserScopedCacheKey,
    record: ProviderModelCacheRecord,
  ): Promise<void>;

  /**
   * Invalidate user-scoped model cache
   */
  invalidateUserModelCache(key: UserScopedCacheKey): Promise<void>;
}
