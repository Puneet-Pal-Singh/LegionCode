import { describe, expect, it, vi } from "vitest";
import type { CoreMessage } from "ai";
import type { Run } from "../../run/index.js";
import type { ILLMGateway } from "../../llm/index.js";
import { determineTurnMode } from "../RunTurnModePolicy.js";

function createRun(): Run {
  return {
    id: "run-1",
    sessionId: "session-1",
    agentType: "coding",
    input: {
      agentType: "coding",
      prompt: "placeholder",
      sessionId: "session-1",
      providerId: "axis",
      modelId: "z-ai/glm-4.5-air:free",
    },
  } as unknown as Run;
}

function createMessages(prompt: string): CoreMessage[] {
  return [{ role: "user", content: prompt }];
}

function createGateway(
  generateStructured: ILLMGateway["generateStructured"],
): ILLMGateway {
  return {
    generateStructured,
    generateText: vi.fn(async () => ({
      text: "unused",
      usage: {
        provider: "mock",
        model: "mock-model",
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      },
    })),
    generateStream: vi.fn(
      async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
    ),
  };
}

describe("RunTurnModePolicy", () => {
  it("routes obvious repository actions through the heuristic path", async () => {
    const generateStructured = vi.fn(async () => ({
      object: {
        mode: "chat" as const,
        rationale: "unused",
        confidence: 0.1,
      },
      usage: {
        provider: "mock",
        model: "mock-model",
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      },
    }));
    const mode = await determineTurnMode({
      llmGateway: createGateway(generateStructured),
      run: createRun(),
      prompt: "read README.md",
      messages: createMessages("read README.md"),
    });

    expect(mode).toEqual(
      expect.objectContaining({
        mode: "action",
        source: "heuristic",
      }),
    );
    expect(generateStructured).not.toHaveBeenCalled();
  });

  it("routes bare README project-review prompts through the heuristic path", async () => {
    const generateStructured = vi.fn(async () => ({
      object: {
        mode: "chat" as const,
        rationale: "unused",
        confidence: 0.1,
      },
      usage: {
        provider: "mock",
        model: "mock-model",
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      },
    }));
    const prompt =
      "Hey, read my readme and tell what do you think of this project??";
    const mode = await determineTurnMode({
      llmGateway: createGateway(generateStructured),
      run: createRun(),
      prompt,
      messages: createMessages(prompt),
    });

    expect(mode).toEqual(
      expect.objectContaining({
        mode: "action",
        source: "heuristic",
      }),
    );
    expect(generateStructured).not.toHaveBeenCalled();
  });

  it("downgrades low-confidence action classification to chat", async () => {
    const generateStructured = vi.fn(async () => ({
      object: {
        mode: "action" as const,
        rationale: "ambiguous",
        confidence: 0.4,
      },
      usage: {
        provider: "mock",
        model: "mock-model",
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      },
    }));
    const mode = await determineTurnMode({
      llmGateway: createGateway(generateStructured),
      run: createRun(),
      prompt: "hey",
      messages: createMessages("hey"),
    });

    expect(mode).toEqual(
      expect.objectContaining({
        mode: "chat",
        source: "llm",
        confidence: 0.4,
      }),
    );
  });

  it("preserves high-confidence action classification", async () => {
    const generateStructured = vi.fn(async () => ({
      object: {
        mode: "action" as const,
        rationale: "user asked to read a file",
        confidence: 0.95,
      },
      usage: {
        provider: "mock",
        model: "mock-model",
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      },
    }));
    const mode = await determineTurnMode({
      llmGateway: createGateway(generateStructured),
      run: createRun(),
      prompt: "read README.md",
      messages: createMessages("read README.md"),
    });

    expect(mode).toEqual(
      expect.objectContaining({
        mode: "action",
        source: "heuristic",
      }),
    );
  });

  it("relies on the gateway default structured timeout budget", async () => {
    const generateStructured = vi.fn(async () => ({
      object: {
        mode: "chat" as const,
        rationale: "conversation",
        confidence: 0.9,
      },
      usage: {
        provider: "mock",
        model: "mock-model",
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      },
    }));
    await determineTurnMode({
      llmGateway: createGateway(generateStructured),
      run: createRun(),
      prompt: "hello there friend",
      messages: createMessages("hello there friend"),
    });

    expect(generateStructured).toHaveBeenCalledTimes(1);
    const request = generateStructured.mock.calls[0]?.[0] as {
      timeoutMs?: number;
    };
    expect(request.timeoutMs).toBeUndefined();
  });
});
