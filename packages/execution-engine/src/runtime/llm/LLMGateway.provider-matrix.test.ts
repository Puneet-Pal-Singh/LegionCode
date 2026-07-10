import { describe, expect, it, vi } from "vitest";
import type { CoreMessage } from "ai";
import { LLMGateway, ProviderCapabilityError } from "./LLMGateway.js";
import type { LLMGatewayDependencies } from "./LLMGateway.js";
import type {
  LLMCallContext,
  LLMRuntimeAIService,
  ProviderCapabilityFlags,
} from "./types.js";
import { projectVisibleTranscriptText } from "@repo/platform-protocol";

interface ProviderMatrixCase {
  providerId: string;
  allowedModel: string;
  blockedModel: string;
}

const PROVIDER_MATRIX: ProviderMatrixCase[] = [
  {
    providerId: "axis",
    allowedModel: "z-ai/glm-4.5-air:free",
    blockedModel: "totally-unknown-axis-model",
  },
  {
    providerId: "openai",
    allowedModel: "gpt-4o",
    blockedModel: "gpt-3-legacy",
  },
  {
    providerId: "anthropic",
    allowedModel: "claude-3-5-sonnet-20241022",
    blockedModel: "claude-1",
  },
  {
    providerId: "groq",
    allowedModel: "llama-3.3-70b-versatile",
    blockedModel: "mixtral-8x7b",
  },
  {
    providerId: "openrouter",
    allowedModel: "arcee-ai/trinity-large-preview:free",
    blockedModel: "totally-unknown-model",
  },
];

const BASE_CONTEXT: LLMCallContext = {
  runId: "run-matrix",
  sessionId: "session-matrix",
  agentType: "planner",
  phase: "task",
};

const BASE_MESSAGES = [{ role: "user", content: "hello" }] as CoreMessage[];

describe("LLMGateway provider behavior matrix", () => {
  it("preserves consistent text/structured/stream behavior across providers", async () => {
    const gateway = createMatrixGateway(PROVIDER_MATRIX);
    const report: Array<Record<string, string>> = [];

    for (const matrixCase of PROVIDER_MATRIX) {
      const textResult = await gateway.generateText({
        context: BASE_CONTEXT,
        providerId: matrixCase.providerId,
        model: matrixCase.allowedModel,
        messages: BASE_MESSAGES,
      });

      const structuredResult = await gateway.generateStructured({
        context: BASE_CONTEXT,
        providerId: matrixCase.providerId,
        model: matrixCase.allowedModel,
        messages: BASE_MESSAGES,
        schema: {
          parse: (value: unknown) => value as { ok: true },
          safeParse: (value: unknown) => ({
            success: true,
            data: value as { ok: true },
          }),
        },
      });

      const stream = await gateway.generateStream({
        context: BASE_CONTEXT,
        providerId: matrixCase.providerId,
        model: matrixCase.allowedModel,
        messages: BASE_MESSAGES,
      });
      const streamText = await collectStreamText(stream);

      report.push({
        providerId: matrixCase.providerId,
        textPath: projectVisibleTranscriptText(textResult.parts),
        structuredPath: JSON.stringify(structuredResult.object),
        streamPath: streamText,
      });
    }

    expect(report).toMatchInlineSnapshot(`
      [
        {
          "providerId": "axis",
          "streamPath": "stream:axis",
          "structuredPath": "{\"ok\":true}",
          "textPath": "text:axis",
        },
        {
          "providerId": "openai",
          "streamPath": "stream:openai",
          "structuredPath": "{\"ok\":true}",
          "textPath": "text:openai",
        },
        {
          "providerId": "anthropic",
          "streamPath": "stream:anthropic",
          "structuredPath": "{\"ok\":true}",
          "textPath": "text:anthropic",
        },
        {
          "providerId": "groq",
          "streamPath": "stream:groq",
          "structuredPath": "{\"ok\":true}",
          "textPath": "text:groq",
        },
        {
          "providerId": "openrouter",
          "streamPath": "stream:openrouter",
          "structuredPath": "{\"ok\":true}",
          "textPath": "text:openrouter",
        },
      ]
    `);
  });

  it("classifies disallowed model outcomes as contract failures", async () => {
    const gateway = createMatrixGateway(PROVIDER_MATRIX);
    const report: Array<Record<string, string>> = [];

    for (const matrixCase of PROVIDER_MATRIX) {
      const outcome = gateway.generateText({
        context: BASE_CONTEXT,
        providerId: matrixCase.providerId,
        model: matrixCase.blockedModel,
        messages: BASE_MESSAGES,
      });
      await expect(outcome).rejects.toBeInstanceOf(ProviderCapabilityError);
      await expect(outcome).rejects.toMatchObject({
        code: "MODEL_NOT_ALLOWED",
      });
      report.push({
        providerId: matrixCase.providerId,
        scenario: "blocked-model",
        classification: "contract",
        result: "MODEL_NOT_ALLOWED",
      });
    }

    expect(report).toMatchInlineSnapshot(`
      [
        {
          "classification": "contract",
          "providerId": "axis",
          "result": "MODEL_NOT_ALLOWED",
          "scenario": "blocked-model",
        },
        {
          "classification": "contract",
          "providerId": "openai",
          "result": "MODEL_NOT_ALLOWED",
          "scenario": "blocked-model",
        },
        {
          "classification": "contract",
          "providerId": "anthropic",
          "result": "MODEL_NOT_ALLOWED",
          "scenario": "blocked-model",
        },
        {
          "classification": "contract",
          "providerId": "groq",
          "result": "MODEL_NOT_ALLOWED",
          "scenario": "blocked-model",
        },
        {
          "classification": "contract",
          "providerId": "openrouter",
          "result": "MODEL_NOT_ALLOWED",
          "scenario": "blocked-model",
        },
      ]
    `);
  });

  it("rejects invalid provider ids consistently", async () => {
    const gateway = createMatrixGateway(PROVIDER_MATRIX);

    const outcome = gateway.generateText({
      context: BASE_CONTEXT,
      providerId: "unknown-provider",
      model: "any-model",
      messages: BASE_MESSAGES,
    });

    await expect(outcome).rejects.toMatchObject({
      code: "INVALID_PROVIDER_SELECTION",
    });
  });
});

function createMatrixGateway(providerMatrix: ProviderMatrixCase[]): LLMGateway {
  const capabilities = buildCapabilities(providerMatrix);
  const allowedModels = buildAllowedModelMap(providerMatrix);

  return new LLMGateway({
    aiService: createMatrixAIService(),
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
        providerCostUsd: 0.001,
        calculatedCostUsd: 0.001,
        pricingSource: "registry",
        shouldBlock: false,
      }),
    },
    providerCapabilityResolver: {
      getCapabilities: (providerId: string) => capabilities[providerId],
      isModelAllowed: (providerId: string, modelId: string) =>
        allowedModels[providerId]?.has(modelId) ?? false,
      getExecutionProfile: () => ({
        latencyTier: "standard",
        reliabilityTier: "baseline",
        supportedLanes: {
          chat_only: { supported: true },
          single_agent_action: { supported: true },
          structured_planning_required: { supported: true },
        },
      }),
    },
  } satisfies LLMGatewayDependencies);
}

function createMatrixAIService(): LLMRuntimeAIService {
  return {
    getProvider: () => "axis",
    getDefaultModel: () => "z-ai/glm-4.5-air:free",
    generateText: vi.fn(async (input) => ({
      text: `text:${input.providerId ?? "default"}`,
      usage: createUsage(input.providerId, input.model),
    })),
    generateStructured: vi.fn(async () => ({
      object: { ok: true },
      usage: createUsage("structured-provider", "structured-model"),
    })),
    createChatStream: vi.fn(async (input) => {
      await input.onFinish?.({
        usage: createUsage(input.providerId, input.model),
      });
      return createStream(`stream:${input.providerId ?? "default"}`);
    }),
  };
}

function buildCapabilities(
  providerMatrix: ProviderMatrixCase[],
): Record<string, ProviderCapabilityFlags> {
  const capabilities: Record<string, ProviderCapabilityFlags> = {};
  for (const matrixCase of providerMatrix) {
    capabilities[matrixCase.providerId] = {
      streaming: true,
      tools: true,
      structuredOutputs: true,
      jsonMode: true,
    };
  }
  return capabilities;
}

function buildAllowedModelMap(
  providerMatrix: ProviderMatrixCase[],
): Record<string, Set<string>> {
  const matrix: Record<string, Set<string>> = {};
  for (const matrixCase of providerMatrix) {
    matrix[matrixCase.providerId] = new Set([matrixCase.allowedModel]);
  }
  return matrix;
}

function createUsage(provider?: string, model?: string) {
  return {
    provider: provider ?? "axis",
    model: model ?? "z-ai/glm-4.5-air:free",
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
  };
}

function createStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

async function collectStreamText(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";

  while (true) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    buffer += decoder.decode(next.value, { stream: true });
  }

  return buffer;
}
