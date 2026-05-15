import type { DurableObjectState as LegacyDurableObjectState } from "@cloudflare/workers-types";
import { z } from "zod";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types/ai";
import { errorResponse, jsonResponse } from "../http/response";
import {
  ValidationError,
  isDomainError,
  mapDomainErrorToHttp,
} from "../domain/errors";
import { parseRequestBody, validateWithSchema } from "../http/validation";
import {
  type BYOKDiscoveredProviderModelsQuery,
  BYOKDiscoveredProviderModelsQuerySchema,
  BYOKDiscoveredProviderModelsRefreshResponseSchema,
  BYOKConnectRequestSchema,
  BYOKDisconnectRequestSchema,
  BYOKPreferencesPatchSchema,
  BYOKValidateRequestSchema,
  ProviderIdSchema,
  type BYOKConnectRequest,
  type BYOKDisconnectRequest,
  type BYOKPreferencesPatch,
  type BYOKValidateRequest,
  type ProviderId,
} from "@repo/shared-types";
import {
  ProviderRateLimitService,
  readByokEncryptionConfig,
} from "../services/providers";
import { ProviderConfigService } from "../services/providers/ProviderConfigService";
import { createPostgresProviderConfigService } from "../services/providers/stores/PostgresStoreFactory";
import { AXIS_PROVIDER_ID } from "../services/providers/axis";
import {
  MAX_SCOPE_IDENTIFIER_LENGTH,
  SAFE_SCOPE_IDENTIFIER_REGEX,
  type ProviderStoreScopeInput,
} from "../types/provider-scope";
import { createCloudflareEventStreamPort } from "./factories/PortalityAdapterFactory";
import { RunEngineRequestHandler } from "./RunEngineRequestHandler";
import { persistAssistantMessageFromRunResponse } from "./RunEngineResponsePersistence";

const RunIdSchema = z.string().uuid();
const ScopeIdSchema = z
  .string()
  .min(1)
  .max(MAX_SCOPE_IDENTIFIER_LENGTH)
  .regex(SAFE_SCOPE_IDENTIFIER_REGEX);
const RefreshModelsRequestSchema = z.object({
  providerId: ProviderIdSchema,
});
const CredentialLabelMutationRequestSchema = z.object({
  credentialId: z.string().uuid(),
  label: z.string().min(1).max(256),
});

export class RunEngineRuntime extends DurableObject {
  private executionQueue: Promise<void> = Promise.resolve();
  private readonly eventStreamPort = createCloudflareEventStreamPort();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const env = this.env as Env;
    const requestHandler = this.createRequestHandler();

    if (url.pathname === "/execute" && request.method === "POST") {
      return requestHandler.handleExecuteRequest(request, (result) => {
        this.ctx.waitUntil(
          persistAssistantMessageFromRunResponse(
            this.ctx,
            this.env as Env,
            result.sessionId,
            result.runId,
            result.correlationId,
            result.response,
          ).catch((error) => {
            console.warn(
              `[run/engine-runtime] ${result.correlationId}: Failed to persist assistant message`,
              error,
            );
          }),
        );
      });
    }

    if (url.pathname === "/summary" && request.method === "GET") {
      return requestHandler.handleSummaryRequest(request);
    }

    if (url.pathname === "/events" && request.method === "GET") {
      return requestHandler.handleEventsRequest(request);
    }

    if (url.pathname === "/events/stream" && request.method === "GET") {
      return requestHandler.handleEventsStreamRequest(request);
    }

    if (url.pathname === "/activity" && request.method === "GET") {
      return requestHandler.handleActivityRequest(request);
    }

    if (url.pathname === "/cancel" && request.method === "POST") {
      return requestHandler.handleCancelRequest(request);
    }

    if (url.pathname === "/approval" && request.method === "POST") {
      return requestHandler.handleApprovalRequest(request);
    }

    if (url.pathname === "/debug/runtime" && request.method === "GET") {
      return requestHandler.handleRuntimeDebugRequest(request);
    }

    if (url.pathname.startsWith("/providers/")) {
      return this.handleProviderRequest(request, url);
    }

    return errorResponse(request, env, "Not Found", 404);
  }

  private async handleProviderRequest(
    request: Request,
    url: URL,
  ): Promise<Response> {
    const correlationId = Math.random().toString(36).substring(7);
    const env = this.env as Env;

    try {
      const scope = this.resolveProviderScope(request, correlationId);
      const configService = this.createProviderConfigService(
        scope,
        correlationId,
      );
      const rateLimitService = this.createProviderRateLimitService(scope);

      if (url.pathname === "/providers/connect") {
        if (request.method !== "POST") {
          return errorResponse(request, env, "Method Not Allowed", 405);
        }
        await rateLimitService.enforce("connect");
        const body = await parseRequestBody(request, correlationId);
        const validatedRequest = validateWithSchema<BYOKConnectRequest>(
          body,
          BYOKConnectRequestSchema,
          correlationId,
        );
        const response = await configService.connect(validatedRequest);
        return jsonResponse(request, env, response);
      }

      if (url.pathname === "/providers/disconnect") {
        if (request.method !== "POST") {
          return errorResponse(request, env, "Method Not Allowed", 405);
        }
        const body = await parseRequestBody(request, correlationId);
        const validatedRequest = validateWithSchema<BYOKDisconnectRequest>(
          body,
          BYOKDisconnectRequestSchema,
          correlationId,
        );
        const response = await configService.disconnect(validatedRequest);
        return jsonResponse(request, env, response);
      }

      if (url.pathname === "/providers/status") {
        if (request.method !== "GET") {
          return errorResponse(request, env, "Method Not Allowed", 405);
        }
        const providers = await configService.getStatus();
        return jsonResponse(request, env, { providers });
      }

      if (url.pathname === "/providers/models") {
        if (request.method !== "GET") {
          return errorResponse(request, env, "Method Not Allowed", 405);
        }
        const providerIdParam = url.searchParams.get("providerId");
        if (!providerIdParam) {
          throw new ValidationError(
            "Missing required query parameter: providerId",
            "MISSING_PROVIDER_ID",
            correlationId,
          );
        }

        const providerId = validateWithSchema<ProviderId>(
          providerIdParam,
          ProviderIdSchema,
          correlationId,
        );
        const isDiscoveryQuery =
          url.searchParams.has("view") ||
          url.searchParams.has("limit") ||
          url.searchParams.has("cursor");
        if (isDiscoveryQuery) {
          const discoveryQuery =
            validateWithSchema<BYOKDiscoveredProviderModelsQuery>(
              {
                view: url.searchParams.get("view") ?? undefined,
                limit: url.searchParams.get("limit") ?? undefined,
                cursor: url.searchParams.get("cursor") ?? undefined,
              },
              BYOKDiscoveredProviderModelsQuerySchema,
              correlationId,
            );
          const discovered = await configService.getDiscoveredModels(
            providerId,
            discoveryQuery,
          );
          return jsonResponse(request, env, discovered);
        }
        const response = await configService.getModels(providerId);
        return jsonResponse(request, env, response);
      }

      if (url.pathname === "/providers/models/refresh") {
        if (request.method !== "POST") {
          return errorResponse(request, env, "Method Not Allowed", 405);
        }
        const body = await parseRequestBody(request, correlationId);
        const refreshRequest = validateWithSchema<{ providerId: ProviderId }>(
          body,
          RefreshModelsRequestSchema,
          correlationId,
        );
        const response = await configService.refreshDiscoveredModels(
          refreshRequest.providerId,
        );
        const validatedResponse = validateWithSchema(
          response,
          BYOKDiscoveredProviderModelsRefreshResponseSchema,
          correlationId,
        );
        return jsonResponse(request, env, validatedResponse);
      }

      if (url.pathname === "/providers/catalog") {
        if (request.method !== "GET") {
          return errorResponse(request, env, "Method Not Allowed", 405);
        }
        const response = await configService.getCatalog();
        return jsonResponse(request, env, response);
      }

      if (url.pathname === "/providers/connections") {
        if (request.method !== "GET") {
          return errorResponse(request, env, "Method Not Allowed", 405);
        }
        const response = await configService.getConnections();
        return jsonResponse(request, env, response);
      }

      if (url.pathname === `/providers/${AXIS_PROVIDER_ID}/quota`) {
        if (request.method !== "GET") {
          return errorResponse(request, env, "Method Not Allowed", 405);
        }
        const response = await configService.getAxisQuotaStatus();
        return jsonResponse(request, env, response);
      }

      if (url.pathname === "/providers/validate") {
        if (request.method !== "POST") {
          return errorResponse(request, env, "Method Not Allowed", 405);
        }
        await rateLimitService.enforce("validate");
        const body = await parseRequestBody(request, correlationId);
        const validatedRequest = validateWithSchema<BYOKValidateRequest>(
          body,
          BYOKValidateRequestSchema,
          correlationId,
        );
        const response = await configService.validate(validatedRequest);
        return jsonResponse(request, env, response);
      }

      if (url.pathname === "/providers/preferences") {
        if (request.method === "GET") {
          const response = await configService.getPreferences();
          return jsonResponse(request, env, response);
        }

        if (request.method !== "PATCH") {
          return errorResponse(request, env, "Method Not Allowed", 405);
        }
        const body = await parseRequestBody(request, correlationId);
        const patch = validateWithSchema<BYOKPreferencesPatch>(
          body,
          BYOKPreferencesPatchSchema,
          correlationId,
        );
        const response = await configService.updatePreferences(patch);
        return jsonResponse(request, env, response);
      }

      if (url.pathname === "/providers/preferences/credential-labels") {
        if (request.method !== "POST") {
          return errorResponse(request, env, "Method Not Allowed", 405);
        }
        const body = await parseRequestBody(request, correlationId);
        const input = validateWithSchema<{
          credentialId: string;
          label: string;
        }>(body, CredentialLabelMutationRequestSchema, correlationId);
        const response = await configService.setCredentialLabel(
          input.credentialId,
          input.label,
        );
        return jsonResponse(request, env, response);
      }

      if (
        url.pathname.startsWith("/providers/preferences/credential-labels/")
      ) {
        if (request.method !== "DELETE") {
          return errorResponse(request, env, "Method Not Allowed", 405);
        }
        const credentialId = this.parseCredentialLabelPath(url, correlationId);
        const response =
          await configService.deleteCredentialLabel(credentialId);
        return jsonResponse(request, env, response);
      }

      return errorResponse(request, env, "Not Found", 404);
    } catch (error: unknown) {
      if (isDomainError(error)) {
        const { status, code, message, metadata } = mapDomainErrorToHttp(error);
        return errorResponse(request, env, message, status, code, metadata);
      }

      console.error(
        `[runtime/provider] ${correlationId}: Unexpected provider route error`,
        error,
      );
      return errorResponse(request, env, "Internal server error", 500);
    }
  }

  private resolveProviderScope(
    request: Request,
    correlationId: string,
  ): ProviderStoreScopeInput {
    const runId = this.parseRequiredRunId(
      request.headers.get("X-Run-Id"),
      correlationId,
    );
    return {
      runId,
      userId: this.parseRequiredScopeHeader(
        request.headers.get("X-User-Id"),
        "X-User-Id",
        correlationId,
      ),
      workspaceId: this.parseRequiredScopeHeader(
        request.headers.get("X-Workspace-Id"),
        "X-Workspace-Id",
        correlationId,
      ),
    };
  }

  private createProviderConfigService(
    scope: ProviderStoreScopeInput,
    _correlationId: string,
  ): ProviderConfigService {
    const env = this.env as Env;
    const userId = scope.userId || "anonymous";
    const workspaceId = scope.workspaceId || "default";
    return createPostgresProviderConfigService(env, userId, workspaceId);
  }

  private createProviderRateLimitService(
    scope: ProviderStoreScopeInput,
  ): ProviderRateLimitService {
    return ProviderRateLimitService.fromEnv(
      this.ctx as unknown as LegacyDurableObjectState,
      scope,
      this.env as Env,
    );
  }

  private resolveProviderEncryptionConfig(correlationId: string) {
    const env = this.env as Env;
    const config = readByokEncryptionConfig(env);
    if (!config) {
      throw new ValidationError(
        "Missing dedicated BYOK credential encryption key (BYOK_CREDENTIAL_ENCRYPTION_KEY)",
        "MISSING_BYOK_ENCRYPTION_KEY",
        correlationId,
      );
    }
    return config;
  }

  private parseRequiredRunId(
    value: string | null,
    correlationId: string,
  ): string {
    if (!value || value.trim().length === 0) {
      throw new ValidationError(
        "Missing required X-Run-Id header",
        "MISSING_RUN_ID",
        correlationId,
      );
    }
    return validateWithSchema<string>(value.trim(), RunIdSchema, correlationId);
  }

  private parseRequiredScopeHeader(
    value: string | null,
    fieldName: string,
    correlationId: string,
  ): string {
    if (!value || value.trim().length === 0) {
      throw new ValidationError(
        `Missing required ${fieldName} header`,
        "MISSING_SCOPE_IDENTIFIER",
        correlationId,
      );
    }

    try {
      return validateWithSchema<string>(
        value.trim(),
        ScopeIdSchema,
        correlationId,
      );
    } catch {
      throw new ValidationError(
        `Invalid ${fieldName} header`,
        "INVALID_SCOPE_IDENTIFIER",
        correlationId,
      );
    }
  }

  private parseCredentialLabelPath(url: URL, correlationId: string): string {
    const match = url.pathname.match(
      /^\/providers\/preferences\/credential-labels\/([^/]+)$/,
    );
    if (!match?.[1]) {
      throw new ValidationError(
        "Invalid credential label path",
        "INVALID_CREDENTIAL_PATH",
        correlationId,
      );
    }

    return validateWithSchema<string>(
      decodeURIComponent(match[1]),
      z.string().uuid(),
      correlationId,
    );
  }

  private async withExecutionLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.executionQueue;
    let release: () => void = () => {};
    this.executionQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private createRequestHandler(): RunEngineRequestHandler {
    return new RunEngineRequestHandler(
      this.ctx,
      this.env as Env,
      this.withExecutionLock.bind(this),
      this.eventStreamPort,
    );
  }
}
