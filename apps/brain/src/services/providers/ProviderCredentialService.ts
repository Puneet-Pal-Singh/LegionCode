/**
 * ProviderCredentialService
 * Single Responsibility: Manage provider API credentials (connect, disconnect, isConnected, getApiKey)
 *
 * Storage Strategy:
 * - Durable store only (single source of truth).
 * - No module-level or isolate-local credential authority.
 */

import type { Env } from "../../types/ai";
import type {
  BYOKConnectRequest,
  BYOKConnectResponse,
  BYOKDisconnectRequest,
  CredentialVault,
  ProviderId,
  ProviderConnectionConfig,
  BYOKValidateRequest,
  BYOKValidateResponse,
} from "@repo/shared-types";
import {
  ValidationError,
  isDomainError,
  ProviderNotConnectedError,
} from "../../domain/errors";
import { ProviderLiveValidationService } from "./ProviderLiveValidationService";
import { ProviderRegistryService } from "./ProviderRegistryService";

/**
 * ProviderCredentialService - Manages provider API credentials
 */
export class ProviderCredentialService {
  private vault: CredentialVault;
  private readonly env: Env;
  private liveValidationService: ProviderLiveValidationService;
  private readonly registryService: ProviderRegistryService;

  constructor(
    env: Env,
    vault: CredentialVault,
    registryService: ProviderRegistryService,
  ) {
    this.env = env;
    this.vault = vault;
    this.registryService = registryService;
    this.liveValidationService = ProviderLiveValidationService.fromEnv(env);
  }

  /**
   * Connect a provider with API key validation.
   * Transport-level shape validation happens at request boundaries; provider-specific
   * key format validation is enforced here before persisting credentials.
   */
  async connect(request: BYOKConnectRequest): Promise<BYOKConnectResponse> {
    try {
      const { providerId, apiKey } = request;
      ensureProviderAllowsManualCredential(this.registryService, providerId);
      const normalizedApiKey = apiKey.trim();
      if (
        !isConnectApiKeyValid(
          this.registryService,
          providerId,
          normalizedApiKey,
        )
      ) {
        return this.failureResponse(
          providerId,
          "Invalid API key format for this provider",
        );
      }
      const now = new Date().toISOString();

      await this.vault.setCredential(
        providerId,
        normalizedApiKey,
        request.config,
      );
      console.log(
        `[provider/credential] ${providerId} connected and persisted (key masked)`,
      );

      return {
        status: "connected" as const,
        providerId,
        lastValidatedAt: now,
      };
    } catch (error) {
      const providerId = request.providerId;
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      if (isDomainError(error)) {
        throw error;
      }
      console.error(
        `[provider/credential] Error connecting ${providerId}:`,
        error,
      );

      return this.failureResponse(providerId, errorMessage);
    }
  }

  async validate(request: BYOKValidateRequest): Promise<BYOKValidateResponse> {
    const { providerId } = request;
    ensureProviderAllowsManualCredential(this.registryService, providerId);
    const validationMode = request.mode ?? "format";
    const apiKey = await this.getApiKey(providerId);
    if (!apiKey) {
      throw new ProviderNotConnectedError(providerId);
    }

    const isValidFormat = this.registryService.isApiKeyFormatValid(
      providerId,
      apiKey,
    );
    if (!isValidFormat) {
      throw new ValidationError(
        `Provider "${providerId}" credential failed validation.`,
        "AUTH_FAILED",
      );
    }

    if (validationMode === "live") {
      this.liveValidationService.ensureEnabled();
      await this.liveValidationService.validate(providerId, apiKey);
    }
    return {
      providerId,
      status: "valid",
      checkedAt: new Date().toISOString(),
      validationMode,
    };
  }

  /**
   * Disconnect a provider
   */
  async disconnect(
    request: BYOKDisconnectRequest,
  ): Promise<{ status: "disconnected"; providerId: ProviderId }> {
    try {
      const { providerId } = request;
      ensureProviderAllowsManualCredential(this.registryService, providerId);

      await this.vault.deleteCredential(providerId);
      console.log(
        `[provider/credential] ${providerId} disconnected (removed from durable)`,
      );

      return {
        status: "disconnected" as const,
        providerId,
      };
    } catch (error) {
      console.error(`[provider/credential] Error disconnecting:`, error);
      throw error;
    }
  }

  /**
   * Get API key for a provider (internal use only)
   * Returns null if provider not connected
   * Uses durable store as the only source of truth.
   */
  async getApiKey(providerId: ProviderId): Promise<string | null> {
    const platformManagedApiKey = this.getPlatformManagedApiKey(providerId);
    if (platformManagedApiKey) {
      return platformManagedApiKey;
    }
    return this.vault.getApiKey(providerId);
  }

  /**
   * Check if provider is connected
   * Uses durable store as the only source of truth.
   */
  async isConnected(providerId: ProviderId): Promise<boolean> {
    if (this.getPlatformManagedApiKey(providerId)) {
      return true;
    }
    return this.vault.isConnected(providerId);
  }

  async getConnectionConfig(
    providerId: ProviderId,
  ): Promise<ProviderConnectionConfig | undefined> {
    return this.vault.getConnectionConfig(providerId);
  }

  private getPlatformManagedApiKey(providerId: ProviderId): string | null {
    const provider = this.registryService.getProvider(providerId);
    if (!provider || !provider.authModes.includes("platform_managed")) {
      return null;
    }

    if (providerId === "axis") {
      const apiKey = this.env.AXIS_OPENROUTER_API_KEY?.trim();
      if (!apiKey || apiKey.length === 0) {
        return null;
      }
      if (!this.registryService.isApiKeyFormatValid("openrouter", apiKey)) {
        throw new ValidationError(
          `Platform-managed credential for "${providerId}" is misconfigured.`,
          "AUTH_FAILED",
        );
      }
      return apiKey;
    }

    return null;
  }

  private failureResponse(
    providerId: ProviderId,
    errorMessage: string,
  ): BYOKConnectResponse {
    return {
      status: "failed" as const,
      providerId,
      errorMessage,
    };
  }

  /**
   * Reset provider credentials for tests
   * Static method for test isolation
   * ⚠️ SECURITY: Only available in test environments
   * @throws Error if called in production environments
   */
  static resetForTests(): void {
    // Durable-store-only implementation has no module-level state to reset.
  }
}

function ensureProviderAllowsManualCredential(
  registryService: ProviderRegistryService,
  providerId: ProviderId,
): void {
  const provider = registryService.getProvider(providerId);
  if (!provider) {
    throw new ValidationError(
      `Provider "${providerId}" is not registered.`,
      "INVALID_PROVIDER_SELECTION",
    );
  }
  if (provider.authModes.includes("platform_managed")) {
    throw new ValidationError(
      `Provider "${providerId}" is platform-managed and cannot be manually connected or disconnected.`,
      "INVALID_PROVIDER_SELECTION",
    );
  }
}

function isConnectApiKeyValid(
  registryService: ProviderRegistryService,
  providerId: ProviderId,
  apiKey: string,
): boolean {
  if (apiKey.length < 10) {
    return false;
  }
  if (!/^[a-zA-Z0-9\-_]+$/.test(apiKey)) {
    return false;
  }
  return registryService.isApiKeyFormatValid(providerId, apiKey);
}
