import { describe, expect, it, vi } from "vitest";
import {
  generateNativeProviderFinalRecovery,
  initialNativeFinalRecoveryAttempts,
} from "./NativeProviderFinalRecovery.js";
import { shouldRetryNativeFinalOnlyResponse } from "./NativeProviderFinalRecoveryPolicy.js";

describe("generateNativeProviderFinalRecovery", () => {
  it("selects final synthesis at the bounded native step limit", () => {
    expect(initialNativeFinalRecoveryAttempts(23, 25)).toBe(0);
    expect(initialNativeFinalRecoveryAttempts(24, 25)).toBe(1);
  });

  it("uses text generation without tools for OpenAI Responses transport", async () => {
    const response = {
      parts: [],
      usage: {
        provider: "openai",
        model: "gpt-5.6",
        promptTokens: 10,
        completionTokens: 3,
        totalTokens: 13,
      },
    };
    const generateText = vi.fn().mockResolvedValue(response);
    const context = {
      runId: "run-1",
      sessionId: "session-1",
      turnId: "turn-1",
      agentType: "coding",
      phase: "synthesis" as const,
      idempotencyKey: "final-recovery-1",
    };

    await expect(
      generateNativeProviderFinalRecovery(
        { generateText },
        {
          context,
          messages: [{ role: "user", content: "Respond with the result." }],
          providerId: "openai",
          model: "gpt-5.6",
          providerTransport: "openai-responses",
          providerEndpoint: "https://api.openai.com/v1/responses",
          system: "Synthesize the completed work.",
        },
      ),
    ).resolves.toBe(response);

    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        context,
        providerTransport: "openai-responses",
        providerEndpoint: "https://api.openai.com/v1/responses",
        tools: undefined,
      }),
    );
  });

  it("retries an empty tool-free Responses recovery through text generation", async () => {
    const visiblePart = {
      id: "part-final-recovery",
      schemaVersion: 1 as const,
      runId: "run-1",
      turnId: "turn-1",
      sequence: 0,
      createdAt: "2026-09-28T00:00:00.000Z",
      type: "visible_text" as const,
      visibility: "visible" as const,
      text: "Recovered answer.",
    };
    const generateText = vi
      .fn()
      .mockResolvedValueOnce({
        parts: [],
        usage: {
          provider: "openai",
          model: "gpt-5.6",
          promptTokens: 10,
          completionTokens: 0,
          totalTokens: 10,
        },
      })
      .mockResolvedValueOnce({
        parts: [visiblePart],
        usage: {
          provider: "openai",
          model: "gpt-5.6",
          promptTokens: 10,
          completionTokens: 3,
          totalTokens: 13,
        },
      });
    const request = {
      context: {
        runId: "run-1",
        sessionId: "session-1",
        turnId: "turn-1",
        agentType: "coding",
        phase: "synthesis" as const,
        idempotencyKey: "final-recovery-empty-1",
      },
      messages: [{ role: "user" as const, content: "Respond with the result." }],
      providerId: "openai",
      model: "gpt-5.6",
      providerTransport: "openai-responses" as const,
      providerEndpoint: "https://api.openai.com/v1/responses",
    };

    const first = await generateNativeProviderFinalRecovery(
      { generateText },
      request,
    );
    expect(
      shouldRetryNativeFinalOnlyResponse({
        recoveryAttemptCount: 0,
        toolCallCount: 0,
        responseParts: first.parts,
      }),
    ).toBe(true);

    const retried = await generateNativeProviderFinalRecovery(
      { generateText },
      { ...request, context: { ...request.context, idempotencyKey: "retry-2" } },
    );
    expect(retried.parts).toEqual([visiblePart]);
    expect(generateText).toHaveBeenCalledTimes(2);
  });
});
