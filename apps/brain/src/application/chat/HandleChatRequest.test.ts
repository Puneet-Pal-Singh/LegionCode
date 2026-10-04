import type { CoreMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../types/ai";
import { ValidationError } from "../../domain/errors";
import { PersistenceService } from "../../services/PersistenceService";
import { DurableConversationContextAssembler } from "../../services/chat/DurableConversationContextAssembler";
import {
  ThreadTitleGenerationCoordinator,
  ThreadTitleService,
} from "../../services/thread-titles";
import { HandleChatRequest } from "./HandleChatRequest";

describe("HandleChatRequest", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(PersistenceService.prototype, "admitUserTurn").mockImplementation(
      async (input) => ({
        id: "message-admitted",
        run: {
          id: input.runId,
          providerId: input.providerId ?? null,
          modelId: input.modelId ?? null,
        } as never,
      }),
    );
    vi.spyOn(
      DurableConversationContextAssembler.prototype,
      "assemble",
    ).mockImplementation(async ({ currentTurnId: _currentTurnId }) => []);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds execution payload after atomically admitting the submitted prompt", async () => {
    const admissionSpy = vi.spyOn(PersistenceService.prototype, "admitUserTurn");
    vi.spyOn(
      PersistenceService.prototype,
      "findFirstPersistedUserMessage",
    ).mockResolvedValue(null);

    const useCase = new HandleChatRequest(createEnv());
    const messages: CoreMessage[] = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "first user" },
      { role: "assistant", content: "assistant response" },
      { role: "user", content: "latest user prompt" },
    ];
    vi.spyOn(
      DurableConversationContextAssembler.prototype,
      "assemble",
    ).mockResolvedValue(messages);

    const result = await executeChat(useCase,
      {
        sessionId: "session-1",
        runId: "123e4567-e89b-42d3-a456-426614174000",
        correlationId: "corr-1",
        agentType: "coding",
        prompt: "latest user prompt",
        messages,
        providerId: "openai",
        modelId: "gpt-4o",
        contextWindowTokens: 999,
        harnessId: "cloudflare-sandbox",
        repositoryOwner: "sourcegraph",
        repositoryName: "legioncode",
        repositoryBranch: "dev",
        repositoryBaseUrl: "https://github.com/sourcegraph/legioncode",
      },
      "https://legioncode.local",
    );

    expect(result.success).toBe(true);
    expect(result.executionPayload.input.mode).toBe("build");
    expect(result.executionPayload.input.agentType).toBe("coding");
    expect(result.executionPayload.input.providerId).toBe("openai");
    expect(result.executionPayload.input.modelId).toBe("gpt-4o");
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
      contextWindowTokens: 999,
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
      repo: "legioncode",
      branch: "dev",
      baseUrl: "https://github.com/sourcegraph/legioncode",
    });
    expect(result.executionPayload.requestOrigin).toBe(
      "https://legioncode.local",
    );
    expect(result.executionPayload.messages).toEqual(messages);
    expect(admissionSpy).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      runId: "123e4567-e89b-42d3-a456-426614174000",
      userId: expect.any(String),
      message: expect.objectContaining({ role: "user", content: "latest user prompt", id: expect.any(String) }),
      mode: "build",
      providerId: "openai",
      modelId: "gpt-4o",
      branch: "dev",
    }));
  });

  it("routes new OpenAI reasoning models and preserves selected effort", async () => {
    vi.spyOn(
      PersistenceService.prototype,
      "persistUserMessage",
    ).mockResolvedValue({ id: "message-luna" } as Awaited<
      ReturnType<PersistenceService["persistUserMessage"]>
    >);
    const result = await executeChat(new HandleChatRequest(createEnv()), {
      sessionId: "session-luna",
      runId: "123e4567-e89b-42d3-a456-426614174000",
      correlationId: "corr-luna",
      agentType: "coding",
      prompt: "inspect",
      messages: [{ role: "user", content: "inspect" }],
      providerId: "openai",
      modelId: "gpt-5.6-luna",
      contextWindowTokens: 400_000,
      pricing: {
        inputPer1M: 1.25,
        outputPer1M: 10,
        currency: "USD",
      },
      reasoningEffort: "high",
      identity: {
        workspaceId: "123e4567-e89b-42d3-a456-426614174003",
        threadId: "thr_luna01",
        turnId: "trn_luna01",
        runAttemptId: "attempt_luna01",
      },
    });

    expect(result.executionPayload.input).toMatchObject({
      runtimeModelId: "gpt-5.6-luna",
      providerTransport: "openai-responses",
      providerEndpoint: "https://api.openai.com/v1/responses",
      metadata: {
        contextWindowTokens: 400_000,
        pricing: {
          inputPer1M: 1.25,
          outputPer1M: 10,
          currency: "USD",
        },
        reasoningEffort: "high",
      },
    });
  });

  it("preserves the trusted discovered route for mixed-transport providers", async () => {
    vi.spyOn(
      PersistenceService.prototype,
      "persistUserMessage",
    ).mockResolvedValue({ id: "message-zen" } as Awaited<
      ReturnType<PersistenceService["persistUserMessage"]>
    >);
    const result = await executeChat(new HandleChatRequest(createEnv()), {
      sessionId: "session-zen",
      runId: "123e4567-e89b-42d3-a456-426614174000",
      correlationId: "corr-zen",
      agentType: "coding",
      prompt: "inspect",
      messages: [{ role: "user", content: "inspect" }],
      providerId: "opencode-zen",
      modelId: "claude-sonnet-4-5",
      providerRuntimeRoute: {
        providerId: "opencode-zen",
        modelId: "claude-sonnet-4-5",
        transport: "anthropic-messages",
        endpoint: "https://opencode.ai/zen/v1/messages",
      },
      identity: {
        workspaceId: "123e4567-e89b-42d3-a456-426614174003",
        threadId: "thr_zen001",
        turnId: "trn_zen001",
        runAttemptId: "attempt_zen001",
      },
    });

    expect(result.executionPayload.input).toMatchObject({
      runtimeModelId: "claude-sonnet-4-5",
      providerTransport: "anthropic-messages",
      providerEndpoint: "https://opencode.ai/zen/v1/messages",
    });
  });

  it("does not issue a metadata-only session or run write before atomic admission", async () => {
    const ensureSessionSpy = vi
      .spyOn(PersistenceService.prototype, "ensureTranscriptSession")
      .mockResolvedValue();
    const ensureRunSpy = vi
      .spyOn(PersistenceService.prototype, "ensureRun")
      .mockResolvedValue(
        {} as Awaited<ReturnType<PersistenceService["ensureRun"]>>,
      );
    const admissionSpy = vi.spyOn(PersistenceService.prototype, "admitUserTurn");
    vi.spyOn(
      PersistenceService.prototype,
      "findFirstPersistedUserMessage",
    ).mockResolvedValue(null);

    const useCase = new HandleChatRequest(createEnv());

    await executeChat(useCase, {
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
      identity: {
        workspaceId: "123e4567-e89b-42d3-a456-426614174003",
        threadId: "thr_order001",
        turnId: "trn_order001",
        runAttemptId: "attempt_order001",
      },
    });

    expect(ensureSessionSpy).not.toHaveBeenCalled();
    expect(ensureRunSpy).not.toHaveBeenCalled();
    expect(admissionSpy).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "123e4567-e89b-42d3-a456-426614174001",
      runId: "123e4567-e89b-42d3-a456-426614174000",
      userId: "123e4567-e89b-42d3-a456-426614174002",
      workspaceId: "123e4567-e89b-42d3-a456-426614174003",
      taskId: "123e4567-e89b-42d3-a456-426614174001",
      mode: "build",
      providerId: "openrouter",
      modelId: "deepseek/deepseek-v4-flash:free",
      branch: null,
    }));
  });

  it("persists a deterministic preview and schedules bounded title inference", async () => {
    vi.spyOn(
      PersistenceService.prototype,
      "ensureTranscriptSession",
    ).mockResolvedValue();
    vi.spyOn(PersistenceService.prototype, "ensureRun").mockResolvedValue({
      id: "123e4567-e89b-42d3-a456-426614174000",
      providerId: "openrouter",
      modelId: "poolside/laguna-s-2.1:free",
    } as Awaited<ReturnType<PersistenceService["ensureRun"]>>);
    vi.spyOn(
      PersistenceService.prototype,
      "admitUserTurn",
    ).mockImplementation(async (input) => ({
      id: "message-first",
      run: {
        id: input.runId,
        providerId: input.providerId ?? null,
        modelId: input.modelId ?? null,
      } as never,
    }));
    vi.spyOn(
      PersistenceService.prototype,
      "findFirstPersistedUserMessage",
    ).mockResolvedValue({
      id: "message-first",
    } as Awaited<
      ReturnType<PersistenceService["findFirstPersistedUserMessage"]>
    >);
    const previewSpy = vi
      .spyOn(ThreadTitleService.prototype, "persistPreview")
      .mockResolvedValue({ titleVersion: 1 } as Awaited<
        ReturnType<ThreadTitleService["persistPreview"]>
      >);
    const waitUntil = vi.fn();
    const scheduleSpy = vi
      .spyOn(ThreadTitleGenerationCoordinator.prototype, "schedule")
      .mockImplementation(() => undefined);

    await executeChat(new HandleChatRequest(createEnv()), {
      sessionId: "123e4567-e89b-42d3-a456-426614174001",
      runId: "123e4567-e89b-42d3-a456-426614174000",
      userId: "123e4567-e89b-42d3-a456-426614174002",
      workspaceId: "123e4567-e89b-42d3-a456-426614174003",
      correlationId: "corr-title-preview",
      agentType: "coding",
      prompt: "edit the readme",
      messages: [{ role: "user", content: "edit the readme" }],
      providerId: "openrouter",
      modelId: "poolside/laguna-s-2.1:free",
      providerRuntimeRoute: {
        providerId: "openrouter",
        modelId: "poolside/laguna-s-2.1:free",
        transport: "openai-chat-completions",
        endpoint: "https://openrouter.ai/api/v1/chat/completions",
      },
      identity: {
        workspaceId: "123e4567-e89b-42d3-a456-426614174003",
        threadId: "thr_title001",
        turnId: "trn_title001",
        runAttemptId: "attempt_title001",
      },
      backgroundTaskOwner: { waitUntil },
    });

    expect(previewSpy).toHaveBeenCalledOnce();
    expect(scheduleSpy).toHaveBeenCalledWith(
      { waitUntil },
      expect.objectContaining({
        prompt: "edit the readme",
        previewVersion: 1,
        providerId: "openrouter",
        modelId: "poolside/laguna-s-2.1:free",
        runtimeModelId: "poolside/laguna-s-2.1:free",
        providerTransport: "openai-chat-completions",
        providerEndpoint: "https://openrouter.ai/api/v1/chat/completions",
      }),
    );
  });

  it("honors explicit runtime selection overrides in execution payload", async () => {
    vi.spyOn(
      PersistenceService.prototype,
      "persistUserMessage",
    ).mockResolvedValue();

    const useCase = new HandleChatRequest(createEnv());
    const result = await executeChat(useCase, {
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
    vi.spyOn(
      PersistenceService.prototype,
      "persistUserMessage",
    ).mockResolvedValue();

    const useCase = new HandleChatRequest(
      createEnv({
        FEATURE_FLAG_GH_CLI_LANE_ENABLED: "true",
        FEATURE_FLAG_GH_CLI_CI_ENABLED: "true",
        FEATURE_FLAG_GH_CLI_PR_COMMENT_ENABLED: "true",
      }),
    );
    const result = await executeChat(useCase, {
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
    vi.spyOn(
      PersistenceService.prototype,
      "persistUserMessage",
    ).mockResolvedValue();

    const useCase = new HandleChatRequest(createEnv());
    const result = await executeChat(useCase, {
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
    vi.spyOn(
      PersistenceService.prototype,
      "persistUserMessage",
    ).mockResolvedValue();

    const useCase = new HandleChatRequest(createEnv());
    const result = await executeChat(useCase, {
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
    vi.spyOn(
      PersistenceService.prototype,
      "persistUserMessage",
    ).mockResolvedValue();

    const useCase = new HandleChatRequest(createEnv());
    const result = await executeChat(useCase, {
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
    vi.spyOn(
      PersistenceService.prototype,
      "persistUserMessage",
    ).mockResolvedValue();

    const useCase = new HandleChatRequest(createEnv());

    await expect(
      executeChat(useCase, {
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
    vi.spyOn(
      PersistenceService.prototype,
      "persistUserMessage",
    ).mockResolvedValue();

    const useCase = new HandleChatRequest(createEnv());

    await expect(
      executeChat(useCase, {
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
    vi.spyOn(
      PersistenceService.prototype,
      "persistUserMessage",
    ).mockResolvedValue();

    const useCase = new HandleChatRequest(createEnv());

    await expect(
      executeChat(useCase, {
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
    vi.spyOn(
      PersistenceService.prototype,
      "persistUserMessage",
    ).mockResolvedValue();

    const useCase = new HandleChatRequest(createEnv());

    await expect(
      executeChat(useCase, {
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
      .spyOn(PersistenceService.prototype, "admitUserTurn")
      .mockRejectedValue(new Error("storage unavailable"));

    const useCase = new HandleChatRequest(createEnv());
    await expect(
      executeChat(useCase, {
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

function executeChat(
  useCase: HandleChatRequest,
  input: Record<string, any>,
  requestOrigin?: string,
) {
  const sessionId = input.sessionId ?? "123e4567-e89b-42d3-a456-426614174001";
  const workspaceId = input.workspaceId ?? "123e4567-e89b-42d3-a456-426614174003";
  const suffix = String(input.correlationId ?? "fixture").replace(/[^a-zA-Z0-9]/g, "").slice(-12) || "fixture01";
  const messages = (input.messages ?? []).map((message: CoreMessage, index: number) =>
    message.role === "user" && typeof (message as { id?: unknown }).id !== "string"
      ? { ...message, id: `client_${suffix}_${index}` }
      : message,
  );
  return useCase.execute(
    {
      userId: input.userId ?? "123e4567-e89b-42d3-a456-426614174002",
      workspaceId,
      identity: input.identity ?? {
        workspaceId,
        threadId: `thr_${suffix}000000000000000000000000`,
        turnId: `trn_${suffix}000000000000000000000000`,
        runAttemptId: `attempt_${suffix}000000000000000000000000`,
      },
      ...input,
      sessionId,
      messages,
    } as Parameters<HandleChatRequest["execute"]>[0],
    requestOrigin,
  );
}
