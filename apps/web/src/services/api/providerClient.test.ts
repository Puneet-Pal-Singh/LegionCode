import { APP_SERVER_PROTOCOL_VERSION } from "@legioncode/sdk";
/**
 * ProviderApiClient Tests
 *
 * Tests for HTTP request handling, error mapping, and response validation.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { ProviderApiClient, ProviderApiError } from "./providerClient.js";

function createCredentialFixture(overrides?: { credentialId?: string }) {
  return {
    credentialId:
      overrides?.credentialId ?? "550e8400-e29b-41d4-a716-446655440000",
    userId: "user-1",
    workspaceId: "workspace-1",
    providerId: "openai",
    label: "Primary",
    keyFingerprint: "sk-****1234",
    encryptedSecretJson: "{}",
    keyVersion: "v1",
    status: "connected" as const,
    lastValidatedAt: null,
    createdAt: "2026-03-04T00:00:00.000Z",
    updatedAt: "2026-03-04T00:00:00.000Z",
    deletedAt: null,
  };
}

function discoveryResponse(method: string, value: unknown, status = 200) {
  const result = method === "provider/catalog" ? { providers: value } : value;
  const payload =
    status < 400
      ? { ok: true, result }
      : {
          ok: false,
          error: {
            ...(value as { error: object }).error,
            retryable: status >= 500 || status === 429,
            statusCode: status,
          },
        };
  return Response.json(
    { protocolVersion: APP_SERVER_PROTOCOL_VERSION, method, ...payload },
    { status },
  );
}

describe("ProviderApiClient", () => {
  const appServerUrl = `${window.location.origin}/__legioncode/brain/app-server/request`;
  const testRunId = "run_123456";
  let client: ProviderApiClient;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client = new ProviderApiClient({
      getRunId: () => testRunId,
    });
    fetchSpy = vi.spyOn(globalThis, "fetch") as unknown as ReturnType<
      typeof vi.spyOn
    >;
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  describe("getCatalog", () => {
    it("fetches provider catalog", async () => {
      const mockCatalog = [
        {
          providerId: "openai",
          displayName: "OpenAI",
          adapterFamily: "openai-compatible",
          authModes: ["api_key"],
          capabilities: {
            streaming: true,
            tools: true,
            jsonMode: true,
            structuredOutputs: true,
          },
          modelSource: "static",
        },
      ];

      fetchSpy.mockResolvedValueOnce(
        discoveryResponse("provider/catalog", mockCatalog, 200),
      );

      const catalog = await client.getCatalog();

      expect(fetchSpy).toHaveBeenCalledWith(
        appServerUrl,
        expect.objectContaining({
          method: "POST",
          credentials: "include",
          signal: expect.any(AbortSignal),
          body: JSON.stringify({
            protocolVersion: APP_SERVER_PROTOCOL_VERSION,
            method: "provider/catalog",
            params: { runId: testRunId },
          }),
        }),
      );
      expect(catalog).toEqual(mockCatalog);
    });
  });

  describe("getProviderModels", () => {
    it("fetches paginated model discovery response for provider", async () => {
      const mockModels = [
        {
          id: "openai/gpt-4o-mini",
          name: "GPT-4o Mini",
          providerId: "openrouter",
          pricing: {
            inputPer1M: 0.15,
            outputPer1M: 0.6,
            currency: "USD",
          },
        },
      ];
      fetchSpy.mockResolvedValueOnce(
        discoveryResponse(
          "provider/models",
          {
            providerId: "openrouter",
            view: "popular",
            models: mockModels,
            page: {
              limit: 20,
              hasMore: false,
            },
            metadata: {
              fetchedAt: "2026-03-04T00:00:00.000Z",
              stale: false,
              source: "provider_api",
            },
          },
          200,
        ),
      );

      const models = await client.getProviderModels("openrouter", {
        view: "popular",
        limit: 20,
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        appServerUrl,
        expect.objectContaining({
          method: "POST",
          credentials: "include",
          signal: expect.any(AbortSignal),
          body: JSON.stringify({
            protocolVersion: APP_SERVER_PROTOCOL_VERSION,
            method: "provider/models",
            params: {
              providerId: "openrouter",
              runId: testRunId,
              query: { view: "popular", surface: "picker", limit: 20 },
            },
          }),
        }),
      );
      expect(models.providerId).toBe("openrouter");
      expect(models.view).toBe("popular");
      expect(models.models).toEqual([
        {
          id: "openai/gpt-4o-mini",
          name: "GPT-4o Mini",
          provider: "openrouter",
          pricing: {
            inputPer1M: 0.15,
            outputPer1M: 0.6,
            currency: "USD",
          },
        },
      ]);
      expect(models.page.hasMore).toBe(false);
      expect(models.metadata.stale).toBe(false);
    });

    it("uses shared query defaults when options are omitted", async () => {
      fetchSpy.mockResolvedValueOnce(
        discoveryResponse(
          "provider/models",
          {
            providerId: "openrouter",
            view: "popular",
            models: [],
            page: {
              limit: 50,
              hasMore: false,
            },
            metadata: {
              fetchedAt: "2026-03-04T00:00:00.000Z",
              stale: false,
              source: "provider_api",
            },
          },
          200,
        ),
      );

      await client.getProviderModels("openrouter");

      expect(fetchSpy).toHaveBeenCalledWith(
        appServerUrl,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            protocolVersion: APP_SERVER_PROTOCOL_VERSION,
            method: "provider/models",
            params: {
              providerId: "openrouter",
              runId: testRunId,
              query: { view: "popular", surface: "picker", limit: 50 },
            },
          }),
        }),
      );
    });

    it("does not cancel concurrent picker and manage inventory requests", async () => {
      const responseFor = (surface: "picker" | "manage") =>
        discoveryResponse("provider/models", {
          providerId: "openrouter",
          view: surface === "picker" ? "popular" : "all",
          models: [],
          page: { limit: surface === "picker" ? 50 : 150, hasMore: false },
          metadata: {
            fetchedAt: "2026-08-21T00:00:00.000Z",
            stale: false,
            source: "provider_api",
            status: "available",
          },
        });
      fetchSpy
        .mockResolvedValueOnce(responseFor("picker"))
        .mockResolvedValueOnce(responseFor("manage"));

      const picker = client.getProviderModels("openrouter", {
        view: "popular",
        surface: "picker",
        limit: 50,
      });
      const manage = client.getProviderModels("openrouter", {
        view: "all",
        surface: "manage",
        limit: 150,
      });

      await Promise.resolve();
      const firstSignal = (fetchSpy.mock.calls[0]?.[1] as RequestInit).signal;
      const secondSignal = (fetchSpy.mock.calls[1]?.[1] as RequestInit).signal;
      expect(firstSignal?.aborted).toBe(false);
      expect(secondSignal?.aborted).toBe(false);
      await expect(Promise.all([picker, manage])).resolves.toHaveLength(2);
    });
  });

  describe("credential operations", () => {
    function expectCommand(method: string, params: object) {
      expect(
        new Headers(
          (fetchSpy.mock.calls.at(-1)?.[1] as RequestInit).headers,
        ).get("Content-Type"),
      ).toBe("application/json");
      expect(fetchSpy).toHaveBeenCalledWith(
        appServerUrl,
        expect.objectContaining({
          method: "POST",
          credentials: "include",
          signal: expect.any(AbortSignal),
          headers: expect.any(Headers),
          body: JSON.stringify({
            protocolVersion: APP_SERVER_PROTOCOL_VERSION,
            method,
            params: { runId: testRunId, ...params },
          }),
        }),
      );
    }

    it("fetches credentials", async () => {
      const mockCredentials = [createCredentialFixture()];
      fetchSpy.mockResolvedValueOnce(
        discoveryResponse("provider/credentials/list", mockCredentials),
      );
      expect(await client.getCredentials()).toEqual(mockCredentials);
      expectCommand("provider/credentials/list", {});
    });

    it("connects a new credential", async () => {
      const credential = createCredentialFixture();
      const request = { providerId: "openai", secret: "sk-test" };
      fetchSpy.mockResolvedValueOnce(
        discoveryResponse("provider/credentials/connect", credential),
      );
      expect(await client.connectCredential(request)).toEqual(credential);
      expectCommand("provider/credentials/connect", { request });
    });

    it("updates the credential label", async () => {
      const credential = { ...createCredentialFixture(), label: "Updated" };
      fetchSpy.mockResolvedValueOnce(
        discoveryResponse("provider/credentials/update", credential),
      );
      expect(
        await client.updateCredential("cred-1", { label: "Updated" }),
      ).toEqual(credential);
      expectCommand("provider/credentials/update", {
        credentialId: "cred-1",
        request: { label: "Updated" },
      });
    });

    it("disconnects a credential", async () => {
      fetchSpy.mockResolvedValueOnce(
        discoveryResponse("provider/credentials/disconnect", {
          disconnected: true,
        }),
      );
      await client.disconnectCredential("cred-1");
      expectCommand("provider/credentials/disconnect", {
        credentialId: "cred-1",
      });
    });

    it.each(["format", "live"] as const)(
      "validates credentials with %s mode",
      async (mode) => {
        const responseBody = {
          credentialId: "550e8400-e29b-41d4-a716-446655440000",
          valid: true,
          validatedAt: "2026-03-04T00:00:00.000Z",
        };
        fetchSpy.mockResolvedValueOnce(
          discoveryResponse("provider/credentials/validate", responseBody),
        );
        expect(await client.validateCredential("cred-1", { mode })).toEqual(
          responseBody,
        );
        expectCommand("provider/credentials/validate", {
          credentialId: "cred-1",
          request: { mode },
        });
      },
    );
  });

  it("reads and persists hosted preferences without a legacy HTTP request", async () => {
    const preferences = {
      userId: "viewer",
      workspaceId: "workspace",
      defaultProviderId: "openai",
      defaultModelId: "gpt-4o",
      visibleModelIds: { openai: ["gpt-4o"] },
      updatedAt: "2026-10-11T00:00:00.000Z",
    };
    fetchSpy.mockResolvedValueOnce(
      discoveryResponse("provider/preferences/read", preferences),
    );
    expect(await client.getPreferences()).toEqual(preferences);
    expect(
      JSON.parse(String((fetchSpy.mock.calls[0]?.[1] as RequestInit).body)),
    ).toEqual({
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      method: "provider/preferences/read",
      params: { runId: testRunId },
    });
    const request = { visibleModelIds: { openai: ["gpt-4o"] } };
    fetchSpy.mockResolvedValueOnce(
      discoveryResponse("provider/preferences/update", preferences),
    );
    expect(await client.updatePreferences(request)).toEqual(preferences);
    expect(
      JSON.parse(String((fetchSpy.mock.calls[1]?.[1] as RequestInit).body)),
    ).toEqual({
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      method: "provider/preferences/update",
      params: { runId: testRunId, request },
    });
    expect(fetchSpy.mock.calls.every(([url]) => url === appServerUrl)).toBe(
      true,
    );
  });

  it("resolves provider configuration with the server's credential and model metadata", async () => {
    const credentialId = createCredentialFixture().credentialId;
    const resolution = {
      providerId: "openai",
      credentialId,
      modelId: "gpt-4o",
      contextWindow: 128000,
      resolvedAt: "request_override",
      resolvedAtTime: "2026-10-11T00:00:00.000Z",
    };
    const request = { providerId: "openai", credentialId, modelId: "gpt-4o" };
    fetchSpy.mockResolvedValueOnce(
      discoveryResponse("provider/resolve", resolution),
    );
    expect(await client.resolveForChat(request)).toEqual(resolution);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(appServerUrl);
    expect(
      JSON.parse(String((fetchSpy.mock.calls[0]?.[1] as RequestInit).body)),
    ).toEqual({
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      method: "provider/resolve",
      params: { runId: testRunId, request },
    });
  });

  describe("error handling", () => {
    it("maps HTTP 400 error", async () => {
      fetchSpy.mockResolvedValueOnce(
        discoveryResponse(
          "provider/catalog",
          {
            error: {
              code: "VALIDATION_ERROR",
              message: "Provider ID is invalid",
            },
          },
          400,
        ),
      );

      try {
        await client.getCatalog();
        expect.fail("Should have thrown error");
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderApiError);
        expect((error as ProviderApiError).code).toBe("VALIDATION_ERROR");
        expect((error as ProviderApiError).statusCode).toBe(400);
      }
    });

    it("marks 5xx errors as retryable", async () => {
      fetchSpy.mockResolvedValueOnce(
        discoveryResponse(
          "provider/catalog",
          {
            error: { code: "INTERNAL_ERROR", message: "Internal server error" },
          },
          500,
        ),
      );

      try {
        await client.getCatalog();
      } catch (error) {
        expect((error as ProviderApiError).isRetryable()).toBe(true);
      }
    });

    it("marks 429 errors as retryable", async () => {
      fetchSpy.mockResolvedValueOnce(
        discoveryResponse(
          "provider/catalog",
          {
            error: { code: "RATE_LIMITED", message: "Too many requests" },
          },
          429,
        ),
      );

      try {
        await client.getCatalog();
      } catch (error) {
        expect((error as ProviderApiError).isRetryable()).toBe(true);
      }
    });

    it("handles network errors", async () => {
      fetchSpy.mockRejectedValueOnce(new Error("Network unreachable"));

      try {
        await client.getCatalog();
        expect.fail("Should have thrown error");
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderApiError);
        expect((error as ProviderApiError).code).toBe("NETWORK_ERROR");
        expect((error as ProviderApiError).statusCode).toBe(500);
        expect((error as ProviderApiError).isRetryable()).toBe(true);
      }
    });

    it("handles abort signal", async () => {
      const error = new Error("Aborted");
      error.name = "AbortError";
      fetchSpy.mockRejectedValueOnce(error);

      try {
        await client.getCatalog();
        expect.fail("Should have thrown error");
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderApiError);
        expect((error as ProviderApiError).code).toBe("ABORTED");
      }
    });

    it("fails fast when run id is missing", async () => {
      const clientWithMissingRunId = new ProviderApiClient({
        getRunId: () => null,
      });
      await expect(clientWithMissingRunId.getCatalog()).rejects.toMatchObject({
        code: "MISSING_RUN_ID",
        statusCode: 400,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("rejects a noncanonical resolver scope before issuing a request", async () => {
      const clientWithStaleScope = new ProviderApiClient({
        getRunId: () => "session_stale_scope",
      });

      await expect(clientWithStaleScope.getCatalog()).rejects.toMatchObject({
        code: "INVALID_REQUEST_CONTRACT",
        statusCode: 400,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("includes correlationId in error", async () => {
      fetchSpy.mockResolvedValueOnce(
        discoveryResponse(
          "provider/catalog",
          {
            error: {
              code: "VALIDATION_ERROR",
              message: "Invalid credential",
              correlationId: "req-123",
            },
          },
          400,
        ),
      );

      try {
        await client.getCatalog();
      } catch (error) {
        expect((error as ProviderApiError).correlationId).toBe("req-123");
      }
    });

    it("maps non-json success payload to invalid response format error", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/html" }),
        text: vi.fn().mockResolvedValueOnce("<!doctype html><html>"),
      });

      await expect(client.getCatalog()).rejects.toMatchObject({
        code: "INVALID_RESPONSE_FORMAT",
        statusCode: 502,
      });
    });

    it("fails when JSON payload violates shared response contract", async () => {
      fetchSpy.mockResolvedValueOnce(
        discoveryResponse(
          "provider/catalog",
          [{ providerId: "openai", displayName: "OpenAI" }],
          200,
        ),
      );

      await expect(client.getCatalog()).rejects.toMatchObject({
        code: "INVALID_RESPONSE_CONTRACT",
        statusCode: 502,
      });
    });
  });

  describe("abort", () => {
    it("aborts in-flight request", async () => {
      fetchSpy.mockImplementationOnce((_url, init) => {
        const signal = (init as RequestInit).signal;
        return new Promise((_resolve, reject) => {
          if (!signal || signal.aborted) {
            reject(new Error("Missing abort signal"));
            return;
          }
          signal.addEventListener("abort", () => {
            const abortError = new Error("Request was aborted");
            abortError.name = "AbortError";
            reject(abortError);
          });
        });
      });

      const request = client.getCatalog();
      client.abort("GET /providers");

      await expect(request).rejects.toMatchObject({
        code: "ABORTED",
        statusCode: 0,
      });
    });

    it("times out in-flight provider requests", async () => {
      vi.useFakeTimers();
      try {
        fetchSpy.mockImplementationOnce((_url, init) => {
          const signal = (init as RequestInit).signal;
          return new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              const abortError = new Error("Request timed out");
              abortError.name = "AbortError";
              reject(abortError);
            });
          });
        });

        const request = client.getCatalog();
        const assertion = expect(request).rejects.toMatchObject({
          code: "ABORTED",
          statusCode: 0,
        });
        await vi.advanceTimersByTimeAsync(15_000);

        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
