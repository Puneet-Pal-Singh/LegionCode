import { describe, expect, it } from "vitest";
import type {
  ContextBudgetSnapshot,
  UsageCostSnapshot,
} from "@repo/platform-protocol";
import { reconcileProviderContextBudget } from "./ProviderContextBudget.js";

describe("reconcileProviderContextBudget", () => {
  it("uses provider-measured total tokens for utilization", () => {
    const result = reconcileProviderContextBudget(budget(), usage());

    expect(result).toMatchObject({
      tokensUsed: 32_500,
      tokensRemaining: 67_500,
      utilizationPercent: 32.5,
      measurementSource: "provider",
    });
  });
});

function budget(): ContextBudgetSnapshot {
  return {
    providerId: "openai",
    modelId: "gpt-4o",
    contextWindowLimit: 128_000,
    systemTokens: null,
    conversationTokens: null,
    toolDefinitionTokens: null,
    attachmentTokens: null,
    repositoryContextTokens: null,
    reservedOutputTokens: 20_000,
    safetyReserveTokens: 8_000,
    effectiveInputBudget: 100_000,
    tokensUsed: 1_000,
    tokensRemaining: 99_000,
    utilizationPercent: 1,
    warningThresholdPercent: 70,
    automaticCompactionThresholdPercent: 80,
    measurementSource: "estimate",
  };
}

function usage(): UsageCostSnapshot {
  return {
    providerId: "openai",
    modelId: "gpt-4o",
    inputTokens: 32_000,
    outputTokens: 500,
    cachedInputTokens: null,
    reasoningTokens: null,
    totalTokens: 32_500,
    currentTurnCost: 0.1,
    cumulativeThreadTokens: 32_500,
    cumulativeThreadCost: 0.1,
    currency: "USD",
    measurementSource: "provider",
  };
}
