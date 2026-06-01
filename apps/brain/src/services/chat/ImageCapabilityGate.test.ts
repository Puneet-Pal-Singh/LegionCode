import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../types/ai";
import { enforceImageCapability } from "./ImageCapabilityGate";

const { getDiscoveredModelsMock } = vi.hoisted(() => ({
  getDiscoveredModelsMock: vi.fn(),
}));

vi.mock("../providers/stores/PostgresStoreFactory", () => ({
  createPostgresProviderConfigService: vi.fn(() => ({
    getDiscoveredModels: getDiscoveredModelsMock,
  })),
}));

describe("enforceImageCapability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows confirmed image input models", async () => {
    getDiscoveredModelsMock.mockResolvedValue({
      models: [
        {
          id: "openai/gpt-4o",
          inputModalities: { image: true },
          capabilityMetadata: { confidence: "confirmed" },
        },
      ],
    });

    await expect(
      enforceImageCapability({
        env: createEnv(),
        userId: "user-1",
        workspaceId: "workspace-1",
        providerId: "openrouter",
        modelId: "openai/gpt-4o",
        hasImages: true,
        correlationId: "corr-1",
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects text-only models before provider dispatch", async () => {
    getDiscoveredModelsMock.mockResolvedValue({
      models: [
        {
          id: "openai/text-only",
          inputModalities: { text: true },
          capabilityMetadata: { confidence: "confirmed" },
        },
      ],
    });

    await expect(
      enforceImageCapability({
        env: createEnv(),
        userId: "user-1",
        workspaceId: "workspace-1",
        providerId: "openrouter",
        modelId: "openai/text-only",
        hasImages: true,
        correlationId: "corr-1",
      }),
    ).rejects.toMatchObject({
      code: "MODEL_DOES_NOT_SUPPORT_IMAGE_INPUT",
    });
  });

  it("rejects unknown capability metadata", async () => {
    getDiscoveredModelsMock.mockResolvedValue({
      models: [{ id: "openai/unknown" }],
    });

    await expect(
      enforceImageCapability({
        env: createEnv(),
        userId: "user-1",
        workspaceId: "workspace-1",
        providerId: "openrouter",
        modelId: "openai/unknown",
        hasImages: true,
        correlationId: "corr-1",
      }),
    ).rejects.toMatchObject({
      code: "MODEL_IMAGE_CAPABILITY_UNKNOWN",
    });
  });
});

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
  };
}
