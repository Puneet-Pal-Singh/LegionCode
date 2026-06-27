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

describe("ProviderApiClient", () => {
  const providerApiBaseUrl = "http://localhost:8788/api/byok";
  const testRunId = "run-123";
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

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: vi.fn().mockResolvedValueOnce(mockCatalog),
      });

      const catalog = await client.getCatalog();

      expect(fetchSpy).toHaveBeenCalledWith(`${providerApiBaseUrl}/providers`, {
        method: "GET",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-Run-Id": testRunId,
        },
        signal: expect.any(AbortSignal),
      });
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
        },
      ];
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: vi.fn().mockResolvedValueOnce({
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
        }),
      });

      const models = await client.getProviderModels("openrouter", {
        view: "popular",
        limit: 20,
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        `${providerApiBaseUrl}/providers/openrouter/models?view=popular&limit=20`,
        {
          method: "GET",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "X-Run-Id": testRunId,
          },
          signal: expect.any(AbortSignal),
        },
      );
      expect(models.providerId).toBe("openrouter");
      expect(models.view).toBe("popular");
      expect(models.models).toEqual([
        {
          id: "openai/gpt-4o-mini",
          name: "GPT-4o Mini",
          provider: "openrouter",
        },
      ]);
      expect(models.page.hasMore).toBe(false);
      expect(models.metadata.stale).toBe(false);
    });

    it("uses shared query defaults when options are omitted", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: vi.fn().mockResolvedValueOnce({
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
        }),
      });

      await client.getProviderModels("openrouter");

      expect(fetchSpy).toHaveBeenCalledWith(
        `${providerApiBaseUrl}/providers/openrouter/models?view=popular&limit=50`,
        expect.objectContaining({ method: "GET" }),
      );
    });
  });

  describe("getCredentials", () => {
    it("fetches credentials", async () => {
      const mockCredentials = [createCredentialFixture()];

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: vi.fn().mockResolvedValueOnce(mockCredentials),
      });

      const credentials = await client.getCredentials();

      expect(fetchSpy).toHaveBeenCalledWith(
        `${providerApiBaseUrl}/credentials`,
        {
          method: "GET",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "X-Run-Id": testRunId,
          },
          signal: expect.any(AbortSignal),
        },
      );
      expect(credentials).toEqual(mockCredentials);
    });
  });

  describe("connectCredential", () => {
    it("connects a new credential", async () => {
      const mockCredential = createCredentialFixture();

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: vi.fn().mockResolvedValueOnce(mockCredential),
      });

      const credential = await client.connectCredential({
        providerId: "openai",
        secret: "sk-test",
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        `${providerApiBaseUrl}/credentials`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "X-Run-Id": testRunId,
          },
          signal: expect.any(AbortSignal),
          body: JSON.stringify({
            providerId: "openai",
            secret: "sk-test",
          }),
        },
      );
      expect(credential).toEqual(mockCredential);
    });
  });

  describe("disconnectCredential", () => {
    it("disconnects credential", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 204,
      });

      await client.disconnectCredential("cred-1");

      expect(fetchSpy).toHaveBeenCalledWith(
        `${providerApiBaseUrl}/credentials/cred-1`,
        {
          method: "DELETE",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "X-Run-Id": testRunId,
          },
          signal: expect.any(AbortSignal),
        },
      );
    });
  });

  describe("validateCredential", () => {
    it("validates credential with format mode", async () => {
      const responseBody = {
        credentialId: "550e8400-e29b-41d4-a716-446655440000",
        valid: true,
        validatedAt: "2026-03-04T00:00:00.000Z",
      };
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: vi.fn().mockResolvedValueOnce(responseBody),
      });

      const result = await client.validateCredential("cred-1", {
        mode: "format",
      });

      expect(result).toEqual(responseBody);
      expect(fetchSpy).toHaveBeenCalledWith(
        `${providerApiBaseUrl}/credentials/cred-1/validate`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ mode: "format" }),
        }),
      );
    });

    it("validates credential with live mode", async () => {
      const responseBody = {
        credentialId: "550e8400-e29b-41d4-a716-446655440000",
        valid: true,
        validatedAt: "2026-03-04T00:00:00.000Z",
      };
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: vi.fn().mockResolvedValueOnce(responseBody),
      });

      const result = await client.validateCredential("cred-1", {
        mode: "live",
      });

      expect(result).toEqual(responseBody);
    });
  });

  describe("error handling", () => {
    it("maps HTTP 400 error", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 400,
        headers: new Headers({ "content-type": "application/json" }),
        json: vi.fn().mockResolvedValueOnce({
          error: {
            code: "VALIDATION_ERROR",
            message: "Provider ID is invalid",
          },
        }),
      });

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
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: new Headers({ "content-type": "application/json" }),
        json: vi.fn().mockResolvedValueOnce({
          error: { code: "INTERNAL_ERROR", message: "Internal server error" },
        }),
      });

      try {
        await client.getCatalog();
      } catch (error) {
        expect((error as ProviderApiError).isRetryable()).toBe(true);
      }
    });

    it("marks 429 errors as retryable", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ "content-type": "application/json" }),
        json: vi.fn().mockResolvedValueOnce({
          error: { code: "RATE_LIMIT", message: "Too many requests" },
        }),
      });

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

    it("includes correlationId in error", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 400,
        headers: new Headers({ "content-type": "application/json" }),
        json: vi.fn().mockResolvedValueOnce({
          error: {
            code: "INVALID_INPUT",
            message: "Invalid credential",
            correlationId: "req-123",
          },
        }),
      });

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
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: vi
          .fn()
          .mockResolvedValueOnce([
            { providerId: "openai", displayName: "OpenAI" },
          ]),
      });

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
          if (!signal) {
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
