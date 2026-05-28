import { describe, expect, it, vi } from "vitest";
import type { CoreMessage } from "ai";
import { z } from "zod";
import {
  LLMGateway,
  LLMTimeoutError,
  LLMUnusableResponseError,
  ProviderCapabilityError,
} from "./LLMGateway.js";
import type { LLMGatewayDependencies } from "./LLMGateway.js";
import type { ProviderCapabilityResolver } from "./types.js";

const baseRequest = {
  context: {
    runId: "run-1",
    sessionId: "session-1",
    agentType: "planner",
    phase: "task" as const,
  },
  providerId: "openai",
  model: "gpt-4o",
  messages: [{ role: "user", content: "hello" }] as CoreMessage[],
};

describe("LLMGateway provider capabilities", () => {
  it("throws INVALID_PROVIDER_SELECTION when provider/model are missing", async () => {
    const gateway = new LLMGateway(
      createDependencies({
        getCapabilities: () => ({
          streaming: true,
          tools: true,
          structuredOutputs: true,
          jsonMode: true,
        }),
        isModelAllowed: () => true,
      }),
    );

    await expect(
      gateway.generateText({
        ...baseRequest,
        providerId: undefined,
        model: undefined,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_PROVIDER_SELECTION",
    });
  });

  it("throws MODEL_NOT_ALLOWED when capability resolver rejects provider/model pair", async () => {
    const gateway = new LLMGateway(
      createDependencies({
        getCapabilities: () => ({
          streaming: true,
          tools: true,
          structuredOutputs: true,
          jsonMode: true,
        }),
        isModelAllowed: () => false,
      }),
    );

    const result = gateway.generateText(baseRequest);
    await expect(result).rejects.toBeInstanceOf(ProviderCapabilityError);
    await expect(result).rejects.toMatchObject({
      code: "MODEL_NOT_ALLOWED",
    });
  });

  it("throws INVALID_PROVIDER_SELECTION when resolver has no provider capabilities", async () => {
    const gateway = new LLMGateway(
      createDependencies({
        getCapabilities: () => undefined,
        isModelAllowed: () => false,
      }),
    );

    await expect(gateway.generateText(baseRequest)).rejects.toMatchObject({
      code: "INVALID_PROVIDER_SELECTION",
    });
  });

  it("allows generation when resolver accepts model", async () => {
    const deps = createDependencies({
      getCapabilities: () => ({
        streaming: true,
        tools: true,
        structuredOutputs: true,
        jsonMode: true,
      }),
      isModelAllowed: () => true,
    });
    const gateway = new LLMGateway(deps);

    const response = await gateway.generateText(baseRequest);

    expect(response.text).toBe("ok");
    expect(deps.aiService.generateText).toHaveBeenCalledTimes(1);
  });

  it("uses explicit providerId when estimating usage for preflight", async () => {
    const deps = createDependencies({
      getCapabilities: () => ({
        streaming: true,
        tools: true,
        structuredOutputs: true,
        jsonMode: true,
      }),
      isModelAllowed: () => true,
    });
    const gateway = new LLMGateway(deps);

    await gateway.generateText({
      ...baseRequest,
      providerId: "axis",
      model: "z-ai/glm-4.5-air:free",
    });

    expect(deps.budgetPolicy.preflight).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        sessionId: "session-1",
      }),
      expect.objectContaining({
        provider: "axis",
        model: "z-ai/glm-4.5-air:free",
      }),
    );
  });

  it("estimates image parts without counting base64 as prompt text", async () => {
    const deps = createDependencies({
      getCapabilities: () => ({
        streaming: true,
        tools: true,
        structuredOutputs: true,
        jsonMode: true,
      }),
      isModelAllowed: () => true,
    });
    const gateway = new LLMGateway(deps);
    const largeDataUrl = `data:image/png;base64,${"a".repeat(20_000)}`;
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          {
            type: "image",
            image: largeDataUrl,
            mimeType: "image/png",
          },
        ],
      },
    ] as unknown as CoreMessage[];

    await gateway.generateText({
      ...baseRequest,
      messages,
    });

    expect(deps.aiService.generateText).toHaveBeenCalledWith(
      expect.objectContaining({ messages }),
    );
    const usage = deps.budgetPolicy.preflight.mock.calls[0]?.[1] as {
      promptTokens: number;
    };
    expect(usage.promptTokens).toBeGreaterThan(1_000);
    expect(usage.promptTokens).toBeLessThan(1_500);
  });

  it("propagates normalized tool calls when provider returns tool calls", async () => {
    const deps = createDependencies({
      getCapabilities: () => ({
        streaming: true,
        tools: true,
        structuredOutputs: true,
        jsonMode: true,
      }),
      isModelAllowed: () => true,
    });
    deps.aiService.generateText.mockResolvedValueOnce({
      text: "tool-step",
      toolCalls: [
        {
          toolName: "read_file",
          args: { path: "README.md" },
        },
      ],
      usage: {
        provider: "openai",
        model: "gpt-4o",
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      },
    });
    const gateway = new LLMGateway(deps);

    const response = await gateway.generateText({
      ...baseRequest,
      tools: {
        read_file: {
          description: "Read file",
        } as unknown as import("ai").CoreTool,
      },
    });

    expect(response.toolCalls).toBeDefined();
    expect(response.toolCalls?.[0]?.toolName).toBe("read_file");
    expect(response.toolCalls?.[0]?.args).toEqual({ path: "README.md" });
    expect(response.toolCalls?.[0]?.id).toBeTruthy();
  });

  it("preserves typed unusable-response errors with provider metadata", async () => {
    const deps = createDependencies({
      getCapabilities: () => ({
        streaming: true,
        tools: true,
        structuredOutputs: true,
        jsonMode: true,
      }),
      isModelAllowed: () => true,
    });
    deps.aiService.generateText.mockRejectedValueOnce(
      new LLMUnusableResponseError({
        providerId: "google",
        modelId: "gemini-2.5-flash-lite",
        anomalyCode: "EMPTY_CANDIDATE",
        finishReason: "stop",
        statusCode: 200,
      }),
    );
    const gateway = new LLMGateway(deps);

    await expect(gateway.generateText(baseRequest)).rejects.toMatchObject({
      name: "LLMUnusableResponseError",
      providerId: "google",
      modelId: "gemini-2.5-flash-lite",
      anomalyCode: "EMPTY_CANDIDATE",
      finishReason: "stop",
      statusCode: 200,
    });
    expect(deps.costLedger.append).toHaveBeenCalledTimes(1);
  });

  it("throws TOOLS_NOT_SUPPORTED when tools are requested for unsupported providers", async () => {
    const gateway = new LLMGateway(
      createDependencies({
        getCapabilities: () => ({
          streaming: true,
          tools: false,
          structuredOutputs: true,
          jsonMode: true,
        }),
        isModelAllowed: () => true,
      }),
    );

    await expect(
      gateway.generateText({
        ...baseRequest,
        tools: {
          read_file: {
            description: "Read file",
          } as unknown as import("ai").CoreTool,
        },
      }),
    ).rejects.toMatchObject({
      code: "TOOLS_NOT_SUPPORTED",
    });
  });

  it("throws EXECUTION_LANE_UNSUPPORTED when task execution uses a provider without tool support", async () => {
    const gateway = new LLMGateway(
      createDependencies({
        getCapabilities: () => ({
          streaming: true,
          tools: true,
          structuredOutputs: true,
          jsonMode: true,
        }),
        isModelAllowed: () => true,
        getExecutionProfile: () => ({
          latencyTier: "standard",
          reliabilityTier: "baseline",
          supportedLanes: {
            chat_only: { supported: true },
            single_agent_action: {
              supported: false,
              reason: "Selected provider does not support tool calling.",
            },
            structured_planning_required: {
              supported: false,
              reason: "Structured planning requires tool-calling support.",
            },
          },
        }),
      }),
    );

    await expect(
      gateway.generateText({
        ...baseRequest,
        context: {
          ...baseRequest.context,
          phase: "task",
        },
      }),
    ).rejects.toMatchObject({
      code: "EXECUTION_LANE_UNSUPPORTED",
      lane: "single_agent_action",
    });
  });

  it("throws STRUCTURED_OUTPUTS_NOT_SUPPORTED before structured planning on incompatible providers", async () => {
    const gateway = new LLMGateway(
      createDependencies({
        getCapabilities: () => ({
          streaming: true,
          tools: true,
          structuredOutputs: false,
          jsonMode: false,
        }),
        isModelAllowed: () => true,
      }),
    );

    await expect(
      gateway.generateStructured({
        ...baseRequest,
        schema: z.object({ ok: z.boolean() }),
        context: {
          ...baseRequest.context,
          phase: "planning",
        },
      }),
    ).rejects.toMatchObject({
      code: "STRUCTURED_OUTPUTS_NOT_SUPPORTED",
    });
  });

  it("fails fast for structured calls that exceed timeout", async () => {
    const deps = createDependencies({
      getCapabilities: () => ({
        streaming: true,
        tools: true,
        structuredOutputs: true,
        jsonMode: true,
      }),
      isModelAllowed: () => true,
    });
    deps.aiService.generateStructured.mockImplementationOnce(
      () => new Promise(() => {}),
    );
    const gateway = new LLMGateway(deps);

    await expect(
      gateway.generateStructured({
        ...baseRequest,
        schema: z.object({ ok: z.boolean() }),
        timeoutMs: 5,
      }),
    ).rejects.toBeInstanceOf(LLMTimeoutError);
  });

  it("persists fallback structured usage when timeout occurs", async () => {
    const deps = createDependencies({
      getCapabilities: () => ({
        streaming: true,
        tools: true,
        structuredOutputs: true,
        jsonMode: true,
      }),
      isModelAllowed: () => true,
    });
    deps.aiService.generateStructured.mockImplementationOnce(
      () => new Promise(() => {}),
    );
    const gateway = new LLMGateway(deps);

    await expect(
      gateway.generateStructured({
        ...baseRequest,
        schema: z.object({ ok: z.boolean() }),
        timeoutMs: 5,
      }),
    ).rejects.toBeInstanceOf(LLMTimeoutError);

    expect(deps.costLedger.append).toHaveBeenCalledTimes(1);
  });

  it("uses the standard task timeout for standard-latency models", async () => {
    vi.useFakeTimers();
    try {
      const deps = createDependencies({
        getCapabilities: () => ({
          streaming: true,
          tools: true,
          structuredOutputs: true,
          jsonMode: true,
        }),
        isModelAllowed: () => true,
      });
      deps.aiService.generateText.mockImplementationOnce(
        () => new Promise(() => {}),
      );
      const gateway = new LLMGateway(deps);

      const outcome = gateway.generateText(baseRequest);
      let settled = false;
      outcome.catch(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(20_001);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(69_999);

      const rejection = expect(outcome).rejects.toMatchObject({
        timeoutMs: 90_000,
        phase: "task",
        operation: "text",
      });
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the fast task timeout for fast-latency models", async () => {
    vi.useFakeTimers();
    try {
      const deps = createDependencies({
        getCapabilities: () => ({
          streaming: true,
          tools: true,
          structuredOutputs: true,
          jsonMode: true,
        }),
        isModelAllowed: () => true,
        getExecutionProfile: () => ({
          latencyTier: "fast",
          reliabilityTier: "hardened",
          supportedLanes: {
            chat_only: { supported: true },
            single_agent_action: { supported: true },
            structured_planning_required: { supported: true },
          },
        }),
      });
      deps.aiService.generateText.mockImplementationOnce(
        () => new Promise(() => {}),
      );
      const gateway = new LLMGateway(deps);

      const outcome = gateway.generateText(baseRequest);
      const rejection = expect(outcome).rejects.toMatchObject({
        timeoutMs: 60_000,
        phase: "task",
        operation: "text",
      });
      await vi.advanceTimersByTimeAsync(60_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("clamps explicit task timeout overrides to the hard maximum", async () => {
    vi.useFakeTimers();
    try {
      const deps = createDependencies({
        getCapabilities: () => ({
          streaming: true,
          tools: true,
          structuredOutputs: true,
          jsonMode: true,
        }),
        isModelAllowed: () => true,
      });
      deps.aiService.generateText.mockImplementationOnce(
        () => new Promise(() => {}),
      );
      const gateway = new LLMGateway(deps);

      const outcome = gateway.generateText({
        ...baseRequest,
        timeoutMs: 250_000,
      });

      const rejection = expect(outcome).rejects.toMatchObject({
        timeoutMs: 180_000,
        phase: "task",
        operation: "text",
      });
      await vi.advanceTimersByTimeAsync(180_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps non-task text calls on the standard default timeout", async () => {
    vi.useFakeTimers();
    try {
      const deps = createDependencies({
        getCapabilities: () => ({
          streaming: true,
          tools: true,
          structuredOutputs: true,
          jsonMode: true,
        }),
        isModelAllowed: () => true,
      });
      deps.aiService.generateText.mockImplementationOnce(
        () => new Promise(() => {}),
      );
      const gateway = new LLMGateway(deps);

      const outcome = gateway.generateText({
        ...baseRequest,
        context: {
          ...baseRequest.context,
          phase: "synthesis",
        },
      });

      const rejection = expect(outcome).rejects.toMatchObject({
        timeoutMs: 20_000,
        phase: "synthesis",
        operation: "text",
      });
      await vi.advanceTimersByTimeAsync(20_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});

function createDependencies(
  resolver: ProviderCapabilityResolver,
): LLMGatewayDependencies & {
  aiService: {
    generateText: ReturnType<typeof vi.fn>;
  };
} {
  return {
    aiService: {
      getProvider: () => "openai",
      getDefaultModel: () => "gpt-4o",
      generateText: vi.fn().mockResolvedValue({
        text: "ok",
        usage: {
          provider: "openai",
          model: "gpt-4o",
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
        },
      }),
      generateStructured: vi.fn(),
      createChatStream: vi.fn(),
    },
    budgetPolicy: {
      preflight: vi.fn().mockResolvedValue(undefined),
      postCommit: vi.fn().mockResolvedValue(undefined),
    },
    costLedger: {
      append: vi.fn().mockResolvedValue(true),
      getEvents: vi.fn(),
      aggregate: vi.fn(),
      getCurrentCost: vi.fn(),
    },
    pricingResolver: {
      resolve: vi.fn().mockReturnValue({
        providerCostUsd: 0.01,
        calculatedCostUsd: 0.01,
        pricingSource: "registry",
        shouldBlock: false,
      }),
    },
    providerCapabilityResolver: {
      getCapabilities: resolver.getCapabilities,
      isModelAllowed: resolver.isModelAllowed,
      getExecutionProfile:
        resolver.getExecutionProfile ??
        (() => ({
          latencyTier: "standard",
          reliabilityTier: "hardened",
          supportedLanes: {
            chat_only: { supported: true },
            single_agent_action: { supported: true },
            structured_planning_required: { supported: true },
          },
        })),
    },
  };
}
