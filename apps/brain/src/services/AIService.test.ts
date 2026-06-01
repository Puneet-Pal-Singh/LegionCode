import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreMessage } from "ai";
import type { Env } from "../types/ai";
import type { ProviderAdapter } from "./providers";
import { AIService } from "./AIService";
import { ProviderConfigService } from "./providers";

const BASE_MESSAGES: CoreMessage[] = [{ role: "user", content: "hello" }];

function createFakeAdapter(provider: string): ProviderAdapter {
  return {
    provider,
    supportedModels: [],
    supportsModel: () => true,
    generate: vi.fn(async (params: { model?: string }) => ({
      content: `${provider}:${params.model ?? "default"}`,
      usage: {
        provider,
        model: params.model ?? "default",
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      },
      finishReason: "stop",
    })),
    generateStream: vi.fn(async function* (params: {
      model?: string;
    }): AsyncGenerator<
      {
        type: "text" | "finish";
        content?: string;
        usage?: {
          provider: string;
          model: string;
          promptTokens: number;
          completionTokens: number;
          totalTokens: number;
        };
        finishReason?: string;
      },
      {
        content: string;
        usage: {
          provider: string;
          model: string;
          promptTokens: number;
          completionTokens: number;
          totalTokens: number;
        };
        finishReason: string;
      },
      unknown
    > {
      const model = params.model ?? "default";
      yield { type: "text", content: `${provider}:${model}` };
      yield {
        type: "finish",
        usage: {
          provider,
          model,
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
        },
        finishReason: "stop",
      };
      return {
        content: `${provider}:${model}`,
        usage: {
          provider,
          model,
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
        },
        finishReason: "stop",
      };
    }),
  };
}

function createEnv(): Env {
  return {
    AI: {} as Env["AI"],
    SECURE_API: {} as Env["SECURE_API"],
    GITHUB_CLIENT_ID: "x",
    GITHUB_CLIENT_SECRET: "x",
    GITHUB_REDIRECT_URI: "x",
    GITHUB_TOKEN_ENCRYPTION_KEY: "x",
    SESSION_SECRET: "x",
    FRONTEND_URL: "x",
    SESSIONS: {} as Env["SESSIONS"],
    RUN_ENGINE_RUNTIME: {} as Env["RUN_ENGINE_RUNTIME"],
    LLM_PROVIDER: "litellm",
    DEFAULT_MODEL: "llama-3.3-70b-versatile",
    GROQ_API_KEY: "test-groq-key",
    AXIS_OPENROUTER_API_KEY: "sk-or-axis-managed-key",
    OPENAI_API_KEY: "sk-env-openai-key",
    BYOK_CREDENTIAL_ENCRYPTION_KEY: "test-master-key-32-chars-minimum",
  };
}

function createProviderConfigService(): ProviderConfigService {
  const env = createEnv();
  const mockCredentialStore = createMockCredentialStore();
  const mockPreferenceStore = createMockPreferenceStore();
  const mockModelCacheStore = createMockModelCacheStore();
  const mockAuditLog = createMockAuditLog();
  const mockQuotaStore = createMockQuotaStore();

  return new ProviderConfigService({
    env,
    userId: "test-user",
    workspaceId: "test-workspace",
    credentialStore: mockCredentialStore,
    preferenceStore: mockPreferenceStore,
    modelCacheStore: mockModelCacheStore,
    auditLog: mockAuditLog,
    quotaStore: mockQuotaStore,
  });
}

function createMockCredentialStore() {
  const connectedProviders = new Set<string>();
  const credentials = new Map<string, { status: string; apiKey: string }>();

  return {
    getCredential: vi.fn().mockImplementation((providerId: string) => {
      const cred = credentials.get(providerId);
      if (!cred) return Promise.resolve(null);
      return Promise.resolve({
        credentialId: "test-cred",
        userId: "test-user",
        workspaceId: "test-workspace",
        providerId,
        label: "default",
        keyFingerprint: "sk-...test",
        status: cred.status as "connected" | "failed" | "revoked",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      });
    }),
    getCredentialWithKey: vi.fn().mockImplementation((providerId: string) => {
      const cred = credentials.get(providerId);
      if (!cred) return Promise.resolve(null);
      return Promise.resolve({
        record: {
          credentialId: "test-cred",
          userId: "test-user",
          workspaceId: "test-workspace",
          providerId,
          label: "default",
          keyFingerprint: "sk-...test",
          status: cred.status as "connected" | "failed" | "revoked",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          deletedAt: null,
        },
        apiKey: cred.apiKey,
      });
    }),
    setCredential: vi
      .fn()
      .mockImplementation((input: { providerId: string; apiKey: string }) => {
        connectedProviders.add(input.providerId);
        credentials.set(input.providerId, {
          status: "connected",
          apiKey: input.apiKey,
        });
        return Promise.resolve({
          credentialId: "test-cred",
          userId: "test-user",
          workspaceId: "test-workspace",
          providerId: input.providerId,
          label: "default",
          keyFingerprint: "sk-...test",
          status: "connected" as const,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          deletedAt: null,
        });
      }),
    deleteCredential: vi.fn().mockImplementation((providerId: string) => {
      connectedProviders.delete(providerId);
      credentials.delete(providerId);
      return Promise.resolve();
    }),
    listCredentialProviders: vi.fn().mockImplementation(() => {
      return Promise.resolve(Array.from(connectedProviders));
    }),
    updateCredentialMetadata: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockPreferenceStore() {
  const prefs = {
    defaultProviderId: "axis",
    defaultModelId: "meta-llama/llama-4-scout-17b-16e-instruct",
    credentialLabels: {} as Record<string, string>,
  };
  return {
    getPreferences: vi
      .fn()
      .mockImplementation(() => Promise.resolve({ ...prefs })),
    updatePreferences: vi
      .fn()
      .mockImplementation(
        (patch: { defaultProviderId?: string; defaultModelId?: string }) => {
          if (patch.defaultProviderId)
            prefs.defaultProviderId = patch.defaultProviderId;
          if (patch.defaultModelId) prefs.defaultModelId = patch.defaultModelId;
          return Promise.resolve({ ...prefs });
        },
      ),
    setCredentialLabel: vi.fn().mockResolvedValue(undefined),
    deleteCredentialLabel: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockModelCacheStore() {
  return {
    getModelCache: vi.fn().mockResolvedValue(null),
    setModelCache: vi.fn().mockResolvedValue(undefined),
    invalidateModelCache: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockAuditLog() {
  return {
    appendAuditEvent: vi.fn().mockResolvedValue(undefined),
    record: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockQuotaStore() {
  return {
    getAxisQuotaUsage: vi.fn().mockResolvedValue(0),
    setAxisQuotaUsage: vi.fn().mockResolvedValue(undefined),
    incrementAndGetQuota: vi.fn().mockResolvedValue(1),
  };
}

function createMockDurableObjectState(): {
  storage: {
    put: (key: string, value: string) => Promise<void>;
    get: (key: string) => Promise<string | undefined>;
    delete: (key: string) => Promise<void>;
    list: (options?: { prefix: string }) => Promise<Map<string, string>>;
  };
} {
  const data = new Map<string, string>();

  return {
    storage: {
      put: async (key: string, value: string) => {
        data.set(key, value);
      },
      get: async (key: string) => data.get(key),
      delete: async (key: string) => {
        data.delete(key);
      },
      list: async (options?: { prefix: string }) => {
        const prefix = options?.prefix ?? "";
        const entries = new Map<string, string>();
        for (const [key, value] of data) {
          if (key.startsWith(prefix)) {
            entries.set(key, value);
          }
        }
        return entries;
      },
    },
  };
}

async function readUint8Stream(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    output += decoder.decode(chunk.value, { stream: true });
  }

  return output;
}

vi.mock("./ai", () => ({
  createDefaultAdapter: vi.fn(),
  selectAdapter: vi.fn(),
  resolveModelSelection: vi.fn(
    (
      _providerId?: string,
      _modelId?: string,
      defaultProvider?: string,
      defaultModel?: string,
    ) => ({
      model: _modelId ?? defaultModel ?? "default",
      provider: _providerId ?? defaultProvider ?? "litellm",
      runtimeProvider: _providerId ?? "litellm",
      fallback: false,
      providerId: _providerId,
    }),
  ),
  mapProviderIdToRuntimeProvider: vi.fn((id: string) => id),
  getRuntimeProviderFromAdapter: vi.fn((adapter: string) => adapter),
  generateText: vi.fn(
    async (
      adapter: ProviderAdapter,
      params: { messages: CoreMessage[]; model?: string },
    ) => {
      const result = await adapter.generate({
        messages: params.messages,
        model: params.model,
      });
      return result;
    },
  ),
  createChatStream: vi.fn(
    async (
      adapter: ProviderAdapter,
      params: { messages: CoreMessage[]; model?: string },
    ) => {
      const encoder = new TextEncoder();
      const model = params.model ?? "default";
      return new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode(`${adapter.provider}:${model}`));
          controller.close();
        },
      });
    },
  ),
  getSDKModelConfig: vi.fn(),
  buildStructuredGenerationUsage: vi.fn(
    (input: { providerId?: string; model: string }) => ({
      provider: input.providerId ?? "openai-compatible",
      model: input.model,
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
    }),
  ),
  getStructuredGenerationMode: vi.fn(() => "auto"),
}));

import * as aiModule from "./ai";

const mockedAi = vi.mocked(aiModule);

describe("AIService provider override routing", () => {
  let litellmAdapter: ProviderAdapter;
  let openaiAdapter: ProviderAdapter;
  let openrouterAdapter: ProviderAdapter;
  let groqAdapter: ProviderAdapter;

  beforeEach(() => {
    ProviderConfigService.resetForTests();
    vi.clearAllMocks();

    litellmAdapter = createFakeAdapter("litellm");
    openaiAdapter = createFakeAdapter("openai");
    openrouterAdapter = createFakeAdapter("openrouter");
    groqAdapter = createFakeAdapter("groq");

    mockedAi.createDefaultAdapter.mockReturnValue(litellmAdapter);
  });

  it("uses default adapter when no provider override is supplied", async () => {
    const providerConfig = createProviderConfigService();
    const service = new AIService(createEnv(), providerConfig);

    mockedAi.selectAdapter.mockResolvedValue(litellmAdapter);

    const result = await service.generateText({
      messages: BASE_MESSAGES,
    });

    expect(result.usage.provider).toBe("litellm");
    expect(litellmAdapter.generate).toHaveBeenCalledTimes(1);
  });

  it("uses persisted BYOK preferences when override is absent", async () => {
    const providerConfig = createProviderConfigService();
    await providerConfig.connect({
      providerId: "openai",
      apiKey: "sk-test-1234567890",
    });
    await providerConfig.updatePreferences({
      defaultProviderId: "openai",
      defaultModelId: "gpt-4o",
    });
    const service = new AIService(createEnv(), providerConfig);

    mockedAi.selectAdapter.mockResolvedValue(openaiAdapter);

    const result = await service.generateText({
      messages: BASE_MESSAGES,
    });

    expect(result.usage.provider).toBe("openai");
    expect(result.usage.model).toBe("gpt-4o");
    expect(mockedAi.resolveModelSelection).toHaveBeenCalledWith(
      "openai",
      "gpt-4o",
      expect.any(String),
      expect.any(String),
      expect.any(Function),
      expect.any(Function),
      undefined,
    );
  });

  it("falls back to adapter defaults when persisted preferences are partial", async () => {
    const providerConfig = createProviderConfigService();
    await providerConfig.updatePreferences({
      defaultProviderId: "openai",
    });
    const service = new AIService(createEnv(), providerConfig);

    mockedAi.selectAdapter.mockResolvedValue(litellmAdapter);

    await service.generateText({
      messages: BASE_MESSAGES,
    });

    expect(mockedAi.resolveModelSelection).toHaveBeenCalledWith(
      undefined,
      undefined,
      expect.any(String),
      expect.any(String),
      expect.any(Function),
      expect.any(Function),
      undefined,
    );
  });

  it("routes to override provider adapter when provider is connected", async () => {
    const providerConfig = createProviderConfigService();
    await providerConfig.connect({
      providerId: "openai",
      apiKey: "sk-test-1234567890",
    });

    const service = new AIService(createEnv(), providerConfig);
    mockedAi.selectAdapter.mockResolvedValue(openaiAdapter);

    const result = await service.generateText({
      messages: BASE_MESSAGES,
      providerId: "openai",
      model: "gpt-4o",
    });

    expect(result.usage.provider).toBe("openai");
    expect(result.usage.model).toBe("gpt-4o");
    expect(openaiAdapter.generate).toHaveBeenCalledTimes(1);
    expect(litellmAdapter.generate).not.toHaveBeenCalled();
  });

  it("passes complete provider route metadata to adapter selection", async () => {
    const providerConfig = createProviderConfigService();
    await providerConfig.connect({
      providerId: "cloudflare-ai",
      apiKey: "cloudflare-api-token",
      config: {
        providerId: "cloudflare-ai",
        accountId: "acct",
        routeMode: "workers-ai-direct",
      },
    });

    const service = new AIService(createEnv(), providerConfig);
    mockedAi.selectAdapter.mockResolvedValue(openaiAdapter);

    await service.generateText({
      messages: BASE_MESSAGES,
      providerId: "cloudflare-ai",
      model: "@cf/meta/llama-3.1-8b-instruct",
      runtimeModelId: "@cf/meta/llama-3.1-8b-instruct",
      providerTransport: "openai-chat-completions",
      providerEndpoint:
        "https://api.cloudflare.com/client/v4/accounts/acct/ai/v1/chat/completions",
    });

    expect(mockedAi.selectAdapter).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.any(Object),
      expect.any(Object),
      undefined,
      {
        providerId: "cloudflare-ai",
        transport: "openai-chat-completions",
        endpoint:
          "https://api.cloudflare.com/client/v4/accounts/acct/ai/v1/chat/completions",
      },
    );
  });

  it("fails fast when provider route metadata is incomplete", async () => {
    const providerConfig = createProviderConfigService();
    const service = new AIService(createEnv(), providerConfig);

    await expect(
      service.generateText({
        messages: BASE_MESSAGES,
        providerId: "cloudflare-ai",
        model: "@cf/meta/llama-3.1-8b-instruct",
        providerTransport: "openai-chat-completions",
      }),
    ).rejects.toMatchObject({ code: "INVALID_PROVIDER_SELECTION" });

    expect(mockedAi.selectAdapter).not.toHaveBeenCalled();
  });

  it("enforces axis quota before runtime inference", async () => {
    const providerConfig = createProviderConfigService();
    const consumeAxisQuotaSpy = vi.spyOn(providerConfig, "consumeAxisQuota");
    const service = new AIService(createEnv(), providerConfig);
    mockedAi.selectAdapter.mockResolvedValue(openrouterAdapter);

    await service.generateText({
      messages: BASE_MESSAGES,
      providerId: "axis",
      model: "z-ai/glm-4.5-air:free",
    });

    expect(consumeAxisQuotaSpy).toHaveBeenCalledTimes(1);
  });

  it("throws ProviderNotConnectedError when override provider is disconnected (strict mode)", async () => {
    const providerConfig = createProviderConfigService();
    const service = new AIService(createEnv(), providerConfig);

    mockedAi.selectAdapter.mockRejectedValue(
      Object.assign(new Error("Provider not connected"), {
        code: "PROVIDER_NOT_CONNECTED",
      }),
    );

    await expect(
      service.generateText({
        messages: BASE_MESSAGES,
        providerId: "openai",
        model: "gpt-4o",
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_NOT_CONNECTED" });

    expect(litellmAdapter.generate).not.toHaveBeenCalled();
    expect(openaiAdapter.generate).not.toHaveBeenCalled();
  });

  it("uses override adapter for stream responses when provider is connected", async () => {
    const providerConfig = createProviderConfigService();
    await providerConfig.connect({
      providerId: "openai",
      apiKey: "sk-test-1234567890",
    });

    const service = new AIService(createEnv(), providerConfig);
    mockedAi.selectAdapter.mockResolvedValue(openaiAdapter);

    const stream = await service.createChatStream({
      messages: BASE_MESSAGES,
      providerId: "openai",
      model: "gpt-4o",
    });

    const content = await readUint8Stream(stream);

    expect(content).toContain("openai");
  });

  describe("Direct OpenRouter and Groq inference (M1.3e)", () => {
    it("routes to OpenRouter adapter when OpenRouter provider is connected", async () => {
      const providerConfig = createProviderConfigService();
      await providerConfig.connect({
        providerId: "openrouter",
        apiKey: "sk-or-test-1234567890",
      });

      const service = new AIService(createEnv(), providerConfig);
      mockedAi.selectAdapter.mockResolvedValue(openrouterAdapter);

      const result = await service.generateText({
        messages: BASE_MESSAGES,
        providerId: "openrouter",
        model: "openai/gpt-4-turbo",
      });

      expect(result.usage.provider).toBe("openrouter");
      expect(result.usage.model).toBe("openai/gpt-4-turbo");
    });

    it("routes to Groq adapter when Groq provider is connected", async () => {
      const providerConfig = createProviderConfigService();
      await providerConfig.connect({
        providerId: "groq",
        apiKey: "gsk_test1234567890",
      });

      const service = new AIService(createEnv(), providerConfig);
      mockedAi.selectAdapter.mockResolvedValue(groqAdapter);

      const result = await service.generateText({
        messages: BASE_MESSAGES,
        providerId: "groq",
        model: "llama-3.3-70b-versatile",
      });

      expect(result.usage.provider).toBe("groq");
      expect(result.usage.model).toBe("llama-3.3-70b-versatile");
    });

    it("throws ProviderNotConnectedError when OpenRouter is not connected (strict mode)", async () => {
      const providerConfig = createProviderConfigService();
      const service = new AIService(createEnv(), providerConfig);

      mockedAi.selectAdapter.mockRejectedValue(
        Object.assign(new Error("Provider not connected"), {
          code: "PROVIDER_NOT_CONNECTED",
        }),
      );

      await expect(
        service.generateText({
          messages: BASE_MESSAGES,
          providerId: "openrouter",
          model: "openai/gpt-4-turbo",
        }),
      ).rejects.toMatchObject({ code: "PROVIDER_NOT_CONNECTED" });
    });

    it("throws ProviderNotConnectedError when Groq is not connected (strict mode)", async () => {
      const providerConfig = createProviderConfigService();
      const service = new AIService(createEnv(), providerConfig);

      mockedAi.selectAdapter.mockRejectedValue(
        Object.assign(new Error("Provider not connected"), {
          code: "PROVIDER_NOT_CONNECTED",
        }),
      );

      await expect(
        service.generateText({
          messages: BASE_MESSAGES,
          providerId: "groq",
          model: "llama-3.3-70b-versatile",
        }),
      ).rejects.toMatchObject({ code: "PROVIDER_NOT_CONNECTED" });
    });

    it("maintains session isolation for provider/model selection", async () => {
      const providerConfig = createProviderConfigService();

      await providerConfig.connect({
        providerId: "groq",
        apiKey: "gsk_test1234567890",
      });
      await providerConfig.connect({
        providerId: "openrouter",
        apiKey: "sk-or-test-1234567890",
      });

      const service = new AIService(createEnv(), providerConfig);

      const selection1 = service.resolveModelSelection(
        "groq",
        "llama-3.3-70b-versatile",
      );
      expect(selection1.providerId).toBe("groq");
      expect(selection1.runtimeProvider).toBe("groq");

      const selection2 = service.resolveModelSelection(
        "openrouter",
        "openai/gpt-4-turbo",
      );
      expect(selection2.providerId).toBe("openrouter");
      expect(selection2.runtimeProvider).toBe("openrouter");

      const selection3 = service.resolveModelSelection("openai", "gpt-4o");
      expect(selection3.providerId).toBe("openai");
      expect(selection3.runtimeProvider).toBe("openai");
    });
  });
});
