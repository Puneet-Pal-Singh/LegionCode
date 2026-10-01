import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../types/ai";
import { createSelectedThreadTitleGenerator } from "./SelectedThreadTitleGenerator";

const { generateText, generateStructured } = vi.hoisted(() => ({
  generateText: vi.fn(),
  generateStructured: vi.fn(),
}));
vi.mock("../AIService", () => ({
  AIService: class {
    generateText = generateText;
    generateStructured = generateStructured;
  },
}));
vi.mock("../providers/stores/PostgresStoreFactory", () => ({
  createPostgresProviderConfigService: vi.fn(),
}));
const input = {
  sessionId: "session",
  threadId: "thread",
  runId: "run",
  workspaceId: "workspace",
  userId: "user",
  firstMessageId: "msg",
  prompt: "Fix login timeout",
  previewVersion: 2,
  providerId: "openai",
  modelId: "chosen-model",
  providerTransport: "openai-chat-completions" as const,
};
beforeEach(() => {
  vi.clearAllMocks();
  generateText.mockResolvedValue({ text: "Fix login timeout" });
  generateStructured.mockResolvedValue({
    object: { title: "Fix login timeout" },
    usage: { totalTokens: 10 },
  });
});

describe("selected title route", () => {
  it("uses the structured service only with positive model and provider capability evidence", async () => {
    const generator = createSelectedThreadTitleGenerator({} as Env, {
      ...input,
      modelCapabilities: {
        supportsStructuredOutputs: true,
        supportsReasoning: false,
      },
    });
    expect(generator.outputFormat).toBe("json");
    expect(
      await generator.generateText({
        messages: [],
        model: input.modelId,
        providerId: input.providerId,
        maxOutputTokens: 128,
      }),
    ).toMatchObject({ text: '{"title":"Fix login timeout"}' });
    expect(generateStructured).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokens: 128 }),
    );
    expect(generateText).not.toHaveBeenCalled();
  });

  it("keeps plain text for unknown model capabilities", async () => {
    const generator = createSelectedThreadTitleGenerator({} as Env, input);
    expect(generator.outputFormat).toBe("text");
    await generator.generateText({
      messages: [],
      model: input.modelId,
      providerId: input.providerId,
      maxOutputTokens: 128,
    });
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputTokens: 2048 }),
    );
    expect(generateStructured).not.toHaveBeenCalled();
  });

  it("keeps native routes on the existing text adapter when structured transport is unwired", () => {
    const generator = createSelectedThreadTitleGenerator({} as Env, {
      ...input,
      providerId: "anthropic",
      providerTransport: "anthropic-messages",
      modelCapabilities: { supportsStructuredOutputs: true },
    });
    expect(generator.outputFormat).toBe("text");
  });

  it("applies low effort only when advertised, with room for reasoning output", async () => {
    const generator = createSelectedThreadTitleGenerator({} as Env, {
      ...input,
      modelCapabilities: {
        supportsReasoning: true,
        reasoningEfforts: ["low", "high"],
      },
    });
    await generator.generateText({
      messages: [],
      model: input.modelId,
      providerId: input.providerId,
      maxOutputTokens: 128,
    });
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        maxOutputTokens: 2048,
        reasoningEffort: "low",
      }),
    );
  });
});
