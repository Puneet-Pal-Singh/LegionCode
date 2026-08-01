import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type {
  ContextBudgetSnapshot,
  UsageCostSnapshot,
} from "@repo/platform-client-sdk";
import { ContextDetailsPanel } from "./ContextDetailsPanel";

const budget: ContextBudgetSnapshot = {
  providerId: "openai",
  modelId: "gpt-5",
  contextWindowLimit: 258_000,
  systemTokens: 4_000,
  conversationTokens: 90_000,
  toolDefinitionTokens: 10_000,
  attachmentTokens: null,
  repositoryContextTokens: null,
  reservedOutputTokens: 20_000,
  safetyReserveTokens: 10_000,
  effectiveInputBudget: 228_000,
  tokensUsed: 108_000,
  tokensRemaining: 120_000,
  utilizationPercent: 47.36,
  warningThresholdPercent: 70,
  automaticCompactionThresholdPercent: 80,
  measurementSource: "tokenizer",
};

const usage: UsageCostSnapshot = {
  providerId: "openai",
  modelId: "gpt-5",
  inputTokens: 12_000,
  outputTokens: 2_000,
  cachedInputTokens: 5_000,
  reasoningTokens: 600,
  totalTokens: 14_000,
  currentTurnCost: 0.12,
  cumulativeThreadTokens: 108_000,
  cumulativeThreadCost: 0.44,
  currency: "USD",
  measurementSource: "provider",
};

describe("ContextDetailsPanel", () => {
  it("renders only canonical runtime context and usage facts", () => {
    render(<ContextDetailsPanel budget={budget} usage={usage} />);

    expect(screen.getByText("258,000")).toBeInTheDocument();
    expect(screen.getAllByText("108,000")).toHaveLength(2);
    expect(screen.getByText("USD 0.44")).toBeInTheDocument();
    expect(
      screen.getByText(/automatic compaction starts at 80%/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /compact context/i }),
    ).not.toBeInTheDocument();
  });

  it("shows unavailable instead of estimating missing provider usage", () => {
    render(<ContextDetailsPanel budget={budget} usage={null} />);

    expect(screen.getAllByText("Unavailable")).toHaveLength(6);
  });
});
