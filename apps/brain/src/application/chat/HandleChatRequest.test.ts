import type { CoreMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../types/ai";
import { ValidationError } from "../../domain/errors";
import { PersistenceService } from "../../services/PersistenceService";
import { HandleChatRequest } from "./HandleChatRequest";

describe("HandleChatRequest", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds execution payload and persists the last user message", async () => {
    const persistSpy = vi
      .spyOn(PersistenceService.prototype, "persistUserMessage")
      .mockResolvedValue();

    const useCase = new HandleChatRequest(createEnv());
    const messages: CoreMessage[] = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "first user" },
      { role: "assistant", content: "assistant response" },
      { role: "user", content: "latest user prompt" },
    ];

    const result = await useCase.execute(
      {
        sessionId: "session-1",
        runId: "123e4567-e89b-42d3-a456-426614174000",
        correlationId: "corr-1",
        agentType: "coding",
        prompt: "latest user prompt",
        messages,
        providerId: "openai",
        modelId: "gpt-4",
        harnessId: "cloudflare-sandbox",
        repositoryOwner: "sourcegraph",
        repositoryName: "shadowbox",
        repositoryBranch: "dev",
        repositoryBaseUrl: "https://github.com/sourcegraph/shadowbox",
      },
      "https://shadowbox.local",
    );

    expect(result.success).toBe(true);
    expect(result.executionPayload.input.mode).toBe("build");
    expect(result.executionPayload.input.agentType).toBe("coding");
    expect(result.executionPayload.input.providerId).toBe("openai");
    expect(result.executionPayload.input.modelId).toBe("gpt-4");
    expect(result.executionPayload.input.harnessId).toBe("cloudflare-sandbox");
    expect(result.executionPayload.input.orchestratorBackend).toBe(
      "execution-engine-v1",
    );
    expect(result.executionPayload.input.executionBackend).toBe(
      "cloudflare_sandbox",
    );
    expect(result.executionPayload.input.harnessMode).toBe("platform_owned");
    expect(result.executionPayload.input.authMode).toBe("api_key");
    expect(result.executionPayload.input.metadata).toEqual({
      featureFlags: {
        agenticLoopV1: false,
        reviewerPassV1: false,
        ghCliLaneEnabled: false,
        ghCliCiEnabled: false,
        ghCliPrCommentEnabled: false,
      },
    });
    expect(result.executionPayload.input.repositoryContext).toEqual({
      owner: "sourcegraph",
      repo: "shadowbox",
      branch: "dev",
      baseUrl: "https://github.com/sourcegraph/shadowbox",
    });
    expect(result.executionPayload.requestOrigin).toBe("https://shadowbox.local");
    expect(result.executionPayload.messages).toEqual(messages);
    expect(persistSpy).toHaveBeenCalledWith(
      "session-1",
      "123e4567-e89b-42d3-a456-426614174000",
      { role: "user", content: "latest user prompt" },
      {
        repository: "sourcegraph/shadowbox",
        userId: undefined,
        workspaceId: undefined,
      },
    );
  });

  it("ensures authenticated sessions and runs before persisting transcript messages", async () => {
    const ensureSessionSpy = vi
      .spyOn(PersistenceService.prototype, "ensureTranscriptSession")
      .mockResolvedValue();
    const ensureRunSpy = vi
      .spyOn(PersistenceService.prototype, "ensureRun")
      .mockResolvedValue({} as Awaited<ReturnType<PersistenceService["ensureRun"]>>);
    const persistSpy = vi
      .spyOn(PersistenceService.prototype, "persistUserMessage")
      .mockResolvedValue();

    const useCase = new HandleChatRequest(createEnv());

    await useCase.execute({
      sessionId: "123e4567-e89b-42d3-a456-426614174001",
      runId: "123e4567-e89b-42d3-a456-426614174000",
      userId: "123e4567-e89b-42d3-a456-426614174002",
      workspaceId: "123e4567-e89b-42d3-a456-426614174003",
      correlationId: "corr-order",
      agentType: "coding",
      prompt: "hello",
      messages: [{ role: "user", content: "hello" }],
      providerId: "openrouter",
      modelId: "deepseek/deepseek-v4-flash:free",
      repositoryOwner: "Puneet-Pal-Singh",
      repositoryName: "career-crew",
    });

    expect(ensureSessionSpy).toHaveBeenCalledWith({
      sessionId: "123e4567-e89b-42d3-a456-426614174001",
      userId: "123e4567-e89b-42d3-a456-426614174002",
      workspaceId: "123e4567-e89b-42d3-a456-426614174003",
      taskId: "123e4567-e89b-42d3-a456-426614174001",
      repository: "Puneet-Pal-Singh/career-crew",
    });
    expect(ensureRunSpy).toHaveBeenCalledWith({
      id: "123e4567-e89b-42d3-a456-426614174000",
      userId: "123e4567-e89b-42d3-a456-426614174002",
      workspaceId: "123e4567-e89b-42d3-a456-426614174003",
      sessionId: "123e4567-e89b-42d3-a456-426614174001",
      taskId: "123e4567-e89b-42d3-a456-426614174001",
      status: "created",
      mode: "build",
      providerId: "openrouter",
      modelId: "deepseek/deepseek-v4-flash:free",
      branch: null,
    });
    expect(ensureSessionSpy.mock.invocationCallOrder[0]).toBeLessThan(
      ensureRunSpy.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(ensureRunSpy.mock.invocationCallOrder[0]).toBeLessThan(
      persistSpy.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("honors explicit runtime selection overrides in execution payload", async () => {
    vi.spyOn(PersistenceService.prototype, "persistUserMessage").mockResolvedValue();

    const useCase = new HandleChatRequest(createEnv());
    const result = await useCase.execute({
      sessionId: "session-1",
      runId: "123e4567-e89b-42d3-a456-426614174000",
      correlationId: "corr-override",
      agentType: "coding",
      prompt: "hello",
      messages: [{ role: "user", content: "hello" }],
      orchestratorBackend: "cloudflare_agents",
      executionBackend: "e2b",
      harnessMode: "delegated",
      authMode: "oauth",
    });

    expect(result.executionPayload.input.orchestratorBackend).toBe(
      "cloudflare_agents",
    );
    expect(result.executionPayload.input.executionBackend).toBe("e2b");
    expect(result.executionPayload.input.harnessMode).toBe("delegated");
    expect(result.executionPayload.input.authMode).toBe("oauth");
  });

  it("propagates GitHub CLI feature flags into run metadata", async () => {
    vi.spyOn(PersistenceService.prototype, "persistUserMessage").mockResolvedValue();

    const useCase = new HandleChatRequest(
      createEnv({
        FEATURE_FLAG_GH_CLI_LANE_ENABLED: "true",
        FEATURE_FLAG_GH_CLI_CI_ENABLED: "true",
        FEATURE_FLAG_GH_CLI_PR_COMMENT_ENABLED: "true",
      }),
    );
    const result = await useCase.execute({
      sessionId: "session-1",
      runId: "123e4567-e89b-42d3-a456-426614174000",
      correlationId: "corr-gh-cli-flags",
      agentType: "coding",
      prompt: "inspect CI logs",
      messages: [{ role: "user", content: "inspect CI logs" }],
    });

    expect(result.executionPayload.input.metadata?.featureFlags).toEqual({
      agenticLoopV1: false,
      reviewerPassV1: false,
      ghCliLaneEnabled: true,
      ghCliCiEnabled: true,
      ghCliPrCommentEnabled: true,
    });
  });

  it("passes explicit plan mode into execution payload", async () => {
    vi.spyOn(PersistenceService.prototype, "persistUserMessage").mockResolvedValue();

    const useCase = new HandleChatRequest(createEnv());
    const result = await useCase.execute({
      sessionId: "session-1",
      runId: "123e4567-e89b-42d3-a456-426614174000",
      correlationId: "corr-plan",
      agentType: "coding",
      mode: "plan",
      prompt: "design the work",
      messages: [{ role: "user", content: "design the work" }],
    });

    expect(result.executionPayload.input.mode).toBe("plan");
  });

  it("passes optional tool definitions into execution payload", async () => {
    vi.spyOn(PersistenceService.prototype, "persistUserMessage").mockResolvedValue();

    const useCase = new HandleChatRequest(createEnv());
    const result = await useCase.execute({
      sessionId: "session-1",
      runId: "123e4567-e89b-42d3-a456-426614174000",
      correlationId: "corr-tools",
      agentType: "coding",
      prompt: "use tools",
      messages: [{ role: "user", content: "use tools" }],
      tools: {
        bash: {
          description: "Run command",
        },
      },
    });

    expect(result.executionPayload.tools).toEqual({
      bash: {
        description: "Run command",
      },
    });
  });

  it("keeps workflow metadata sparse when no workflow entrypoint is provided", async () => {
    vi.spyOn(PersistenceService.prototype, "persistUserMessage").mockResolvedValue();

    const useCase = new HandleChatRequest(createEnv());
    const result = await useCase.execute({
      sessionId: "session-1",
      runId: "123e4567-e89b-42d3-a456-426614174000",
      correlationId: "corr-workflow",
      agentType: "coding",
      prompt: "review this diff",
      messages: [{ role: "user", content: "review this diff" }],
      workflowIntent: "review",
    });

    expect(result.executionPayload.input.metadata).toEqual({
      featureFlags: {
        agenticLoopV1: false,
        reviewerPassV1: false,
        ghCliLaneEnabled: false,
        ghCliCiEnabled: false,
        ghCliPrCommentEnabled: false,
      },
      workflow: {
        entrypoint: undefined,
        intent: "review",
      },
    });
  });

  it("throws NO_MESSAGES when messages are empty", async () => {
    vi.spyOn(PersistenceService.prototype, "persistUserMessage").mockResolvedValue();

    const useCase = new HandleChatRequest(createEnv());

    await expect(
      useCase.execute({
        sessionId: "session-1",
        runId: "123e4567-e89b-42d3-a456-426614174000",
        correlationId: "corr-2",
        agentType: "coding",
        prompt: "hello",
        messages: [],
      }),
    ).rejects.toMatchObject<Partial<ValidationError>>({
      code: "NO_MESSAGES",
    });
  });

  it("throws NO_USER_MESSAGE when history has no user messages", async () => {
    vi.spyOn(PersistenceService.prototype, "persistUserMessage").mockResolvedValue();

    const useCase = new HandleChatRequest(createEnv());

    await expect(
      useCase.execute({
        sessionId: "session-1",
        runId: "123e4567-e89b-42d3-a456-426614174000",
        correlationId: "corr-3",
        agentType: "coding",
        prompt: "hello",
        messages: [{ role: "assistant", content: "only assistant" }],
      }),
    ).rejects.toMatchObject<Partial<ValidationError>>({
      code: "NO_USER_MESSAGE",
    });
  });

  it("rejects stale history that does not end with the submitted prompt", async () => {
    vi.spyOn(PersistenceService.prototype, "persistUserMessage").mockResolvedValue();

    const useCase = new HandleChatRequest(createEnv());

    await expect(
      useCase.execute({
        sessionId: "session-1",
        runId: "123e4567-e89b-42d3-a456-426614174000",
        correlationId: "corr-stale-history",
        agentType: "coding",
        prompt: "fresh prompt",
        messages: [
          { role: "user", content: "fresh prompt" },
          { role: "assistant", content: "stale answer" },
        ],
      }),
    ).rejects.toMatchObject<Partial<ValidationError>>({
      code: "LATEST_MESSAGE_NOT_USER",
    });
  });

  it("rejects prompts that do not match the latest user message", async () => {
    vi.spyOn(PersistenceService.prototype, "persistUserMessage").mockResolvedValue();

    const useCase = new HandleChatRequest(createEnv());

    await expect(
      useCase.execute({
        sessionId: "session-1",
        runId: "123e4567-e89b-42d3-a456-426614174000",
        correlationId: "corr-mismatched-prompt",
        agentType: "coding",
        prompt: "different prompt",
        messages: [{ role: "user", content: "latest user prompt" }],
      }),
    ).rejects.toMatchObject<Partial<ValidationError>>({
      code: "PROMPT_MESSAGE_MISMATCH",
    });
  });

  it("fails fast when the canonical user message cannot be persisted", async () => {
    const persistSpy = vi
      .spyOn(PersistenceService.prototype, "persistUserMessage")
      .mockRejectedValue(new Error("storage unavailable"));

    const useCase = new HandleChatRequest(createEnv());
    await expect(
      useCase.execute({
        sessionId: "session-1",
        runId: "123e4567-e89b-42d3-a456-426614174000",
        correlationId: "corr-4",
        agentType: "coding",
        prompt: "hello",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toThrow("storage unavailable");

    expect(persistSpy).toHaveBeenCalledTimes(1);
  });
});

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    AI: {} as Env["AI"],
    SECURE_API: {
      fetch: vi.fn(async () => new Response(JSON.stringify({ success: true }))),
    } as unknown as Env["SECURE_API"],
    GITHUB_CLIENT_ID: "x",
    GITHUB_CLIENT_SECRET: "x",
    GITHUB_REDIRECT_URI: "x",
    GITHUB_TOKEN_ENCRYPTION_KEY: "x",
    SESSION_SECRET: "x",
    FRONTEND_URL: "x",
    SESSIONS: {} as Env["SESSIONS"],
    RUN_ENGINE_RUNTIME: {} as Env["RUN_ENGINE_RUNTIME"],
    ...overrides,
  };
}
