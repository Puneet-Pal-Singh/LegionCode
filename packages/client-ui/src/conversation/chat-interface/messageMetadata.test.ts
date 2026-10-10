import { describe, expect, it } from "vitest";
import { TurnIdSchema } from "@legioncode/sdk";
import { createLifecycleProjection } from "@legioncode/sdk";
import {
  buildLifecycleMessageMetadata,
} from "./messageMetadata.js";

describe("messageMetadata", () => {
  it("uses canonical lifecycle usage for model and settlement metadata", () => {
    const turnId = TurnIdSchema.parse("trn_metadata02");
    const projection = {
      ...createLifecycleProjection(turnId),
      startedAt: "2026-08-13T16:55:00.000Z",
      settledAt: "2026-08-13T16:56:14.000Z",
      usage: {
        providerId: "google",
        modelId: "gemma-4-31b-it",
        inputTokens: 1_000,
        outputTokens: 100,
        cachedInputTokens: null,
        reasoningTokens: null,
        totalTokens: 1_100,
        currentTurnCost: 0,
        cumulativeThreadTokens: 1_100,
        cumulativeThreadCost: 0,
        currency: "USD",
        measurementSource: "provider" as const,
      },
    };

    expect(
      buildLifecycleMessageMetadata(
        projection,
        { modeLabel: "Build" },
        (modelId) => (modelId === "gemma-4-31b-it" ? "Gemma 4 31B" : modelId),
        "Build",
      ),
    ).toMatchObject({
      modeLabel: "Build",
      modelLabel: "Gemma 4 31B",
      durationLabel: "74s",
      timeLabel: expect.any(String),
    });
  });
});
