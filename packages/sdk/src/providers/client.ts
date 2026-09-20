import { z } from "zod";
import {
  ProviderClientContractError,
  normalizeProviderClientOperationError,
} from "./errors.js";
import {
  BYOKCredentialConnectRequestSchema,
  BYOKCredentialSchema,
  BYOKCredentialUpdateRequestSchema,
  BYOKCredentialValidateRequestSchema,
  BYOKCredentialValidateResponseSchema,
  BYOKDiscoveredProviderModelsQuerySchema,
  BYOKDiscoveredProviderModelsRefreshResponseSchema,
  BYOKDiscoveredProviderModelsResponseSchema,
  BYOKPreferenceSchema,
  BYOKPreferencesUpdateRequestSchema,
  BYOKResolutionSchema,
  BYOKResolveRequestSchema,
  ProviderRegistryEntrySchema,
  type BYOKCredential,
  type BYOKCredentialConnectRequest,
  type BYOKCredentialUpdateRequest,
  type BYOKCredentialValidateRequest,
  type BYOKCredentialValidateResponse,
  type BYOKDiscoveredProviderModelsRefreshResponse,
  type BYOKDiscoveredProviderModelsResponse,
  type BYOKPreference,
  type BYOKPreferencesUpdateRequest,
  type BYOKResolution,
  type BYOKResolveRequest,
  type ProviderModelsQuery,
  type ProviderRegistryEntry,
} from "./types.js";

const ProviderCatalogSchema = ProviderRegistryEntrySchema.array();
const CredentialListSchema = BYOKCredentialSchema.array();

export interface ProviderClientOperationOptions {
  signal?: AbortSignal;
}

export interface ProviderClientTransport {
  discoverProviders(options?: ProviderClientOperationOptions): Promise<unknown>;
  discoverProviderModels(
    providerId: string,
    query: unknown,
    options?: ProviderClientOperationOptions,
  ): Promise<unknown>;
  refreshProviderModels(
    providerId: string,
    options?: ProviderClientOperationOptions,
  ): Promise<unknown>;
  listCredentials(options?: ProviderClientOperationOptions): Promise<unknown>;
  connectCredential(
    request: BYOKCredentialConnectRequest,
    options?: ProviderClientOperationOptions,
  ): Promise<unknown>;
  updateCredential(
    credentialId: string,
    request: BYOKCredentialUpdateRequest,
    options?: ProviderClientOperationOptions,
  ): Promise<unknown>;
  disconnectCredential(
    credentialId: string,
    options?: ProviderClientOperationOptions,
  ): Promise<void>;
  validateCredential(
    credentialId: string,
    request: BYOKCredentialValidateRequest,
    options?: ProviderClientOperationOptions,
  ): Promise<unknown>;
  getPreferences(options?: ProviderClientOperationOptions): Promise<unknown>;
  updatePreferences(
    request: BYOKPreferencesUpdateRequest,
    options?: ProviderClientOperationOptions,
  ): Promise<unknown>;
  resolveForRun(
    request: BYOKResolveRequest,
    options?: ProviderClientOperationOptions,
  ): Promise<unknown>;
}

export class ProviderClient {
  constructor(private readonly transport: ProviderClientTransport) {}

  async discoverProviders(
    options?: ProviderClientOperationOptions,
  ): Promise<ProviderRegistryEntry[]> {
    const payload = await this.invokeTransportOperation(
      "discoverProviders",
      () => this.transport.discoverProviders(options),
    );
    return parseResponse(payload, ProviderCatalogSchema, "discoverProviders");
  }

  async discoverProviderModels(
    providerId: string,
    query: ProviderModelsQuery = {},
    options?: ProviderClientOperationOptions,
  ): Promise<BYOKDiscoveredProviderModelsResponse> {
    const normalizedProviderId = requireIdentifier(
      providerId,
      "providerId",
      "discoverProviderModels",
    );
    const normalizedQuery = parseRequest(
      query,
      BYOKDiscoveredProviderModelsQuerySchema,
      "discoverProviderModels",
    );
    const payload = await this.invokeTransportOperation(
      "discoverProviderModels",
      () =>
        this.transport.discoverProviderModels(
          normalizedProviderId,
          normalizedQuery,
          options,
        ),
    );
    return parseResponse(
      payload,
      BYOKDiscoveredProviderModelsResponseSchema,
      "discoverProviderModels",
    );
  }

  async refreshProviderModels(
    providerId: string,
    options?: ProviderClientOperationOptions,
  ): Promise<BYOKDiscoveredProviderModelsRefreshResponse> {
    const normalizedProviderId = requireIdentifier(
      providerId,
      "providerId",
      "refreshProviderModels",
    );
    const payload = await this.invokeTransportOperation(
      "refreshProviderModels",
      () => this.transport.refreshProviderModels(normalizedProviderId, options),
    );
    return parseResponse(
      payload,
      BYOKDiscoveredProviderModelsRefreshResponseSchema,
      "refreshProviderModels",
    );
  }

  async listCredentials(
    options?: ProviderClientOperationOptions,
  ): Promise<BYOKCredential[]> {
    const payload = await this.invokeTransportOperation("listCredentials", () =>
      this.transport.listCredentials(options),
    );
    return parseResponse(payload, CredentialListSchema, "listCredentials");
  }

  async connectCredential(
    request: BYOKCredentialConnectRequest,
    options?: ProviderClientOperationOptions,
  ): Promise<BYOKCredential> {
    const normalizedRequest = parseRequest(
      request,
      BYOKCredentialConnectRequestSchema,
      "connectCredential",
    );
    const payload = await this.invokeTransportOperation("connectCredential", () =>
      this.transport.connectCredential(normalizedRequest, options),
    );
    return parseResponse(payload, BYOKCredentialSchema, "connectCredential");
  }

  async updateCredential(
    credentialId: string,
    request: BYOKCredentialUpdateRequest,
    options?: ProviderClientOperationOptions,
  ): Promise<BYOKCredential> {
    const normalizedCredentialId = requireIdentifier(
      credentialId,
      "credentialId",
      "updateCredential",
    );
    const normalizedRequest = parseRequest(
      request,
      BYOKCredentialUpdateRequestSchema,
      "updateCredential",
    );
    const payload = await this.invokeTransportOperation("updateCredential", () =>
      this.transport.updateCredential(
        normalizedCredentialId,
        normalizedRequest,
        options,
      ),
    );
    return parseResponse(payload, BYOKCredentialSchema, "updateCredential");
  }

  async disconnectCredential(
    credentialId: string,
    options?: ProviderClientOperationOptions,
  ): Promise<void> {
    const normalizedCredentialId = requireIdentifier(
      credentialId,
      "credentialId",
      "disconnectCredential",
    );
    await this.invokeTransportOperation("disconnectCredential", () =>
      this.transport.disconnectCredential(normalizedCredentialId, options),
    );
  }

  async validateCredential(
    credentialId: string,
    request: BYOKCredentialValidateRequest,
    options?: ProviderClientOperationOptions,
  ): Promise<BYOKCredentialValidateResponse> {
    const normalizedCredentialId = requireIdentifier(
      credentialId,
      "credentialId",
      "validateCredential",
    );
    const normalizedRequest = parseRequest(
      request,
      BYOKCredentialValidateRequestSchema,
      "validateCredential",
    );
    const payload = await this.invokeTransportOperation("validateCredential", () =>
      this.transport.validateCredential(
        normalizedCredentialId,
        normalizedRequest,
        options,
      ),
    );
    return parseResponse(
      payload,
      BYOKCredentialValidateResponseSchema,
      "validateCredential",
    );
  }

  async getPreferences(
    options?: ProviderClientOperationOptions,
  ): Promise<BYOKPreference> {
    const payload = await this.invokeTransportOperation("getPreferences", () =>
      this.transport.getPreferences(options),
    );
    return parseResponse(payload, BYOKPreferenceSchema, "getPreferences");
  }

  async selectDefault(
    request: BYOKPreferencesUpdateRequest,
    options?: ProviderClientOperationOptions,
  ): Promise<BYOKPreference> {
    const normalizedRequest = parseRequest(
      request,
      BYOKPreferencesUpdateRequestSchema,
      "selectDefault",
    );
    const payload = await this.invokeTransportOperation("selectDefault", () =>
      this.transport.updatePreferences(normalizedRequest, options),
    );
    return parseResponse(payload, BYOKPreferenceSchema, "selectDefault");
  }

  async resolveForRun(
    request: BYOKResolveRequest,
    options?: ProviderClientOperationOptions,
  ): Promise<BYOKResolution> {
    const normalizedRequest = parseRequest(
      request,
      BYOKResolveRequestSchema,
      "resolveForRun",
    );
    const payload = await this.invokeTransportOperation("resolveForRun", () =>
      this.transport.resolveForRun(normalizedRequest, options),
    );
    return parseResponse(payload, BYOKResolutionSchema, "resolveForRun");
  }

  private async invokeTransportOperation<T>(
    operation: string,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw normalizeProviderClientOperationError(error, operation);
    }
  }
}

export function createProviderClient(
  transport: ProviderClientTransport,
): ProviderClient {
  return new ProviderClient(transport);
}

function parseRequest<TSchema extends z.ZodTypeAny>(
  payload: unknown,
  schema: TSchema,
  operation: string,
): z.output<TSchema> {
  return parseContract(payload, schema, "request", operation);
}

function parseResponse<TSchema extends z.ZodTypeAny>(
  payload: unknown,
  schema: TSchema,
  operation: string,
): z.output<TSchema> {
  return parseContract(payload, schema, "response", operation);
}

function parseContract<TSchema extends z.ZodTypeAny>(
  payload: unknown,
  schema: TSchema,
  phase: "request" | "response",
  operation: string,
): z.output<TSchema> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ProviderClientContractError(
      phase,
      operation,
      `Invalid ${phase} contract for ${operation}`,
    );
  }
  return parsed.data;
}

function requireIdentifier(
  value: string,
  fieldName: string,
  operation: string,
): string {
  const normalizedValue = value.trim();
  if (normalizedValue.length === 0) {
    throw new ProviderClientContractError(
      "request",
      operation,
      `Missing required identifier: ${fieldName}`,
    );
  }
  return normalizedValue;
}
