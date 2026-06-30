import { describe, it, expect } from "vitest";
import {
  BYOKConnectRequestSchema,
  BYOKConnectResponseSchema,
  BYOKCredentialConnectRequestSchema,
  BYOKCredentialValidateRequestSchema,
  BYOKCredentialValidateResponseSchema,
  BYOKDiscoveredProviderModelsQuerySchema,
  BYOKDiscoveredProviderModelsResponseSchema,
  BYOKPreferencesUpdateRequestSchema,
  BYOKValidateRequestSchema,
  BYOKValidateResponseSchema,
} from "./api.js";
import {
  BYOKConnectRequestSchema as ProviderConnectRequestSchema,
  BYOKConnectResponseSchema as ProviderConnectResponseSchema,
  BYOKValidateRequestSchema as ProviderValidateRequestSchema,
  BYOKValidateResponseSchema as ProviderValidateResponseSchema,
} from "../provider.js";

describe("BYOK API Contracts", () => {
  it("validates connect request", () => {
    const request = {
      providerId: "openai",
      apiKey: "sk-test-FAKE-KEY-DO-NOT-USE",
    };

    const result = BYOKConnectRequestSchema.safeParse(request);
    expect(result.success).toBe(true);
  });

  it("validates Cloudflare AI connect config", () => {
    const request = {
      providerId: "cloudflare-ai",
      apiKey: "cf-test-token",
      config: {
        providerId: "cloudflare-ai",
        accountId: "account_123",
        gatewayId: "gateway-123",
        routeMode: "ai-gateway" as const,
      },
    };

    const result = BYOKConnectRequestSchema.safeParse(request);
    expect(result.success).toBe(true);
  });

  it("requires Cloudflare AI config on connect", () => {
    const request = {
      providerId: "cloudflare-ai",
      apiKey: "cf-test-token",
    };

    const result = BYOKConnectRequestSchema.safeParse(request);
    expect(result.success).toBe(false);
  });

  it("rejects mismatched provider connection config", () => {
    const request = {
      providerId: "opencode-go",
      apiKey: "oc-test-token",
      config: {
        providerId: "cloudflare-ai",
        accountId: "account_123",
        routeMode: "workers-ai-direct" as const,
      },
    };

    const result = BYOKConnectRequestSchema.safeParse(request);
    expect(result.success).toBe(false);
  });

  it("validates validate request", () => {
    const request = {
      providerId: "openai",
      mode: "live" as const,
    };

    const result = BYOKValidateRequestSchema.safeParse(request);
    expect(result.success).toBe(true);
  });

  it("accepts canonical connect response shape", () => {
    const response = {
      status: "connected" as const,
      providerId: "openai",
      lastValidatedAt: new Date().toISOString(),
    };

    const result = BYOKConnectResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
  });

  it("accepts canonical validate response shape", () => {
    const response = {
      providerId: "openai",
      status: "valid" as const,
      checkedAt: new Date().toISOString(),
      validationMode: "format" as const,
    };

    const result = BYOKValidateResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
  });

  it("validates credential connect request shape for /api/byok/credentials", () => {
    const request = {
      providerId: "openai",
      secret: "sk-test-FAKE-KEY-DO-NOT-USE",
      label: "Primary key",
    };

    const result = BYOKCredentialConnectRequestSchema.safeParse(request);
    expect(result.success).toBe(true);
  });

  it("validates credential validation request/response shape", () => {
    const request = { mode: "live" as const };
    const response = {
      credentialId: "550e8400-e29b-41d4-a716-446655440000",
      valid: true,
      validatedAt: new Date().toISOString(),
    };

    expect(BYOKCredentialValidateRequestSchema.safeParse(request).success).toBe(
      true,
    );
    expect(
      BYOKCredentialValidateResponseSchema.safeParse(response).success,
    ).toBe(true);
  });

  it("validates discovered provider model query/response shape", () => {
    const query = { view: "all" as const, limit: 100, cursor: "cursor-1" };
    const response = {
      providerId: "openrouter",
      view: "all" as const,
      models: [
        {
          id: "openai/gpt-4o",
          name: "GPT-4o",
          providerId: "openrouter",
        },
      ],
      page: {
        limit: 100,
        cursor: "cursor-1",
        hasMore: false,
      },
      metadata: {
        fetchedAt: new Date().toISOString(),
        stale: false,
        source: "cache" as const,
      },
    };

    expect(
      BYOKDiscoveredProviderModelsQuerySchema.safeParse(query).success,
    ).toBe(true);
    expect(
      BYOKDiscoveredProviderModelsResponseSchema.safeParse(response).success,
    ).toBe(true);
  });

  it("rejects empty preferences update patch", () => {
    const result = BYOKPreferencesUpdateRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("re-exports canonical provider schemas to prevent drift", () => {
    expect(BYOKConnectRequestSchema).toBe(ProviderConnectRequestSchema);
    expect(BYOKConnectResponseSchema).toBe(ProviderConnectResponseSchema);
    expect(BYOKValidateRequestSchema).toBe(ProviderValidateRequestSchema);
    expect(BYOKValidateResponseSchema).toBe(ProviderValidateResponseSchema);
  });
});
