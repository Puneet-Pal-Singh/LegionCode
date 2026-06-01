/**
 * Provider API Client v3
 *
 * Web-facing adapter that consumes the canonical provider SDK client.
 * Keeps backward-compatible method names for existing web store usage.
 */

import {
  createByokHttpTransport,
  createProviderClient,
  ProviderClientContractError,
  ProviderClientOperationError,
  type BYOKCredential,
  type BYOKCredentialConnectRequest,
  type BYOKCredentialUpdateRequest,
  type BYOKCredentialValidateRequest,
  type BYOKCredentialValidateResponse,
  type BYOKDiscoveredProviderModelsQuery,
  type BYOKDiscoveredProviderModelsRefreshResponse,
  type BYOKPreferencesUpdateRequest,
  type BYOKPreference,
  type BYOKResolution,
  type BYOKResolveRequest,
  type ProviderRegistryEntry,
} from "@repo/platform-client-sdk";
import type {
  BYOKModelDiscoverySource,
  BYOKModelDiscoverySurface,
  ProviderModelAvailability,
} from "@repo/shared-types";
import { getBrainHttpBase } from "../../lib/platform-endpoints.js";
import { SessionStateService } from "../SessionStateService";

export type ConnectCredentialRequest = BYOKCredentialConnectRequest;
export type UpdateCredentialRequest = BYOKCredentialUpdateRequest;
export type ValidateCredentialRequest = BYOKCredentialValidateRequest;
export type ValidationResult = BYOKCredentialValidateResponse;

export interface ProviderModelOption {
  id: string;
  name: string;
  provider?: string;
  availability?: ProviderModelAvailability;
  unavailableReason?: string;
}

export type ProviderModelDiscoveryView =
  BYOKDiscoveredProviderModelsQuery["view"];

export interface ProviderModelsQuery {
  view?: ProviderModelDiscoveryView;
  surface?: BYOKModelDiscoverySurface;
  limit?: number;
  cursor?: string;
}

export interface ProviderModelsPageInfo {
  limit: number;
  cursor?: string;
  nextCursor?: string;
  hasMore: boolean;
}

export interface ProviderModelsMetadata {
  fetchedAt: string;
  stale: boolean;
  source: BYOKModelDiscoverySource;
  staleReason?: string;
}

export interface ProviderModelsPageResult {
  providerId: string;
  view: ProviderModelDiscoveryView;
  models: ProviderModelOption[];
  page: ProviderModelsPageInfo;
  metadata: ProviderModelsMetadata;
}

export interface RunIdResolver {
  getRunId(): string | null;
}

export type ResolveChatRequest = BYOKResolveRequest;
export type ProviderCredential = BYOKCredential;
export type ProviderPreference = BYOKPreference;
export type ProviderResolution = BYOKResolution;

/**
 * HTTP error wrapper for provider API failures
 */
export class ProviderApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public correlationId?: string,
  ) {
    super(message);
    this.name = "ProviderApiError";
  }

  isRetryable(): boolean {
    return this.statusCode >= 500 || this.statusCode === 429;
  }
}

export class ProviderApiClient {
  private static readonly sessionRunIdKey = "currentRunId";
  private readonly sdkClient;
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(
    private readonly runIdResolver: RunIdResolver = new DefaultRunIdResolver(
      ProviderApiClient.sessionRunIdKey,
    ),
  ) {
    this.sdkClient = createProviderClient(
      createByokHttpTransport({
        baseUrl: `${getBrainHttpBase()}/api/byok`,
        getRunId: () => this.resolveRunId(),
        getHeaders: () => this.resolveAuthHeaders(),
      }),
    );
  }

  async getCatalog(): Promise<ProviderRegistryEntry[]> {
    return this.callWithAbortKey("GET /providers", (signal) =>
      this.sdkClient.discoverProviders({ signal }),
    );
  }

  async getProviderModels(
    providerId: string,
    query: ProviderModelsQuery = {},
  ): Promise<ProviderModelsPageResult> {
    const requestKey = `GET /providers/${encodeURIComponent(providerId)}/models`;
    const response = await this.callWithAbortKey(requestKey, (signal) =>
      this.sdkClient.discoverProviderModels(providerId, query, { signal }),
    );
    return {
      providerId: response.providerId,
      view: response.view,
      models: response.models.map((model) => ({
        id: model.id,
        name: model.name,
        provider: model.providerId,
        availability: model.availability,
        unavailableReason: model.unavailableReason,
      })),
      page: response.page,
      metadata: response.metadata,
    };
  }

  async refreshProviderModels(
    providerId: string,
  ): Promise<BYOKDiscoveredProviderModelsRefreshResponse> {
    const requestKey = `POST /providers/${encodeURIComponent(providerId)}/models/refresh`;
    return this.callWithAbortKey(requestKey, (signal) =>
      this.sdkClient.refreshProviderModels(providerId, { signal }),
    );
  }

  async getCredentials(): Promise<ProviderCredential[]> {
    return this.callWithAbortKey("GET /credentials", (signal) =>
      this.sdkClient.listCredentials({ signal }),
    );
  }

  async connectCredential(
    req: ConnectCredentialRequest,
  ): Promise<ProviderCredential> {
    return this.callWithAbortKey("POST /credentials", (signal) =>
      this.sdkClient.connectCredential(req, { signal }),
    );
  }

  async updateCredential(
    credentialId: string,
    req: UpdateCredentialRequest,
  ): Promise<ProviderCredential> {
    const requestKey = `PATCH /credentials/${encodeURIComponent(credentialId)}`;
    return this.callWithAbortKey(requestKey, (signal) =>
      this.sdkClient.updateCredential(credentialId, req, { signal }),
    );
  }

  async disconnectCredential(credentialId: string): Promise<void> {
    const requestKey = `DELETE /credentials/${encodeURIComponent(credentialId)}`;
    await this.callWithAbortKey(requestKey, (signal) =>
      this.sdkClient.disconnectCredential(credentialId, { signal }),
    );
  }

  async validateCredential(
    credentialId: string,
    req: ValidateCredentialRequest,
  ): Promise<ValidationResult> {
    const requestKey = `POST /credentials/${encodeURIComponent(credentialId)}/validate`;
    return this.callWithAbortKey(requestKey, (signal) =>
      this.sdkClient.validateCredential(credentialId, req, { signal }),
    );
  }

  async getPreferences(): Promise<ProviderPreference> {
    return this.callWithAbortKey("GET /preferences", (signal) =>
      this.sdkClient.getPreferences({ signal }),
    );
  }

  async updatePreferences(
    req: BYOKPreferencesUpdateRequest,
  ): Promise<ProviderPreference> {
    return this.callWithAbortKey("PATCH /preferences", (signal) =>
      this.sdkClient.selectDefault(req, { signal }),
    );
  }

  async resolveForChat(req: ResolveChatRequest): Promise<ProviderResolution> {
    return this.callWithAbortKey("POST /resolve", (signal) =>
      this.sdkClient.resolveForRun(req, { signal }),
    );
  }

  abort(key: string): void {
    const controller = this.abortControllers.get(key);
    if (!controller) {
      return;
    }
    controller.abort();
    this.abortControllers.delete(key);
  }

  private resolveRunId(): string | null {
    return this.runIdResolver.getRunId();
  }

  private resolveAuthHeaders(): Record<string, string> {
    return {};
  }

  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw mapProviderApiError(error);
    }
  }

  private async callWithAbortKey<T>(
    key: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = this.prepareAbortController(key);
    try {
      return await this.call(() => operation(controller.signal));
    } finally {
      this.releaseAbortController(key, controller);
    }
  }

  private prepareAbortController(key: string): AbortController {
    const existing = this.abortControllers.get(key);
    if (existing) {
      existing.abort();
    }
    const controller = new AbortController();
    this.abortControllers.set(key, controller);
    return controller;
  }

  private releaseAbortController(
    key: string,
    controller: AbortController,
  ): void {
    if (this.abortControllers.get(key) === controller) {
      this.abortControllers.delete(key);
    }
  }
}

function mapProviderApiError(error: unknown): ProviderApiError {
  if (error instanceof ProviderApiError) {
    return error;
  }
  if (error instanceof ProviderClientContractError) {
    const statusCode = error.phase === "request" ? 400 : 502;
    const code =
      error.phase === "request"
        ? "INVALID_REQUEST_CONTRACT"
        : "INVALID_RESPONSE_CONTRACT";
    return new ProviderApiError(statusCode, code, error.message);
  }
  if (error instanceof ProviderClientOperationError) {
    const statusCode =
      error.statusCode && error.statusCode > 0
        ? error.statusCode
        : deriveStatusCodeFromOperationError(error.code, error.retryable);
    return new ProviderApiError(
      statusCode,
      error.code,
      error.message,
      error.correlationId,
    );
  }
  if (error instanceof Error) {
    return new ProviderApiError(500, "NETWORK_ERROR", error.message);
  }
  return new ProviderApiError(500, "NETWORK_ERROR", "Network request failed");
}

function deriveStatusCodeFromOperationError(
  code: string,
  retryable: boolean,
): number {
  if (code === "ABORTED") {
    return 0;
  }
  if (code === "MISSING_RUN_ID" || code === "INVALID_REQUEST_CONTRACT") {
    return 400;
  }
  if (
    code === "INVALID_RESPONSE_CONTRACT" ||
    code === "INVALID_RESPONSE_FORMAT" ||
    code === "INVALID_ERROR_RESPONSE"
  ) {
    return 502;
  }
  if (
    code === "RATE_LIMIT_EXCEEDED" ||
    code === "PROVIDER_RATE_LIMITED" ||
    code === "QUOTA_EXCEEDED" ||
    code === "AXIS_DAILY_LIMIT_EXCEEDED"
  ) {
    return 429;
  }
  if (retryable || code === "NETWORK_ERROR") {
    return 500;
  }
  return 400;
}

class DefaultRunIdResolver implements RunIdResolver {
  constructor(private readonly runIdStorageKey: string) {}

  getRunId(): string | null {
    try {
      const runId = sessionStorage.getItem(this.runIdStorageKey);
      if (runId) {
        return runId;
      }
    } catch (error) {
      console.warn(
        "[provider/resolveRunId] Failed to read sessionStorage",
        error,
      );
    }
    return SessionStateService.loadActiveSessionRunId();
  }
}
