import { describe, expect, it } from "vitest";
import type { Message } from "@ai-sdk/react";
import { TurnIdSchema } from "@repo/platform-client-sdk";
import { createLifecycleProjection } from "../../services/lifecycle/LifecycleProjection.js";
import {
  buildConversationTurns,
  buildLifecycleMessageMetadata,
} from "./messageMetadata.js";

describe("messageMetadata", () => {
  it("builds conversation turns from actual message identities", () => {
    const turns = buildConversationTurns([
      {
        id: "user-1",
        role: "user",
        content: "hey",
      },
      {
        id: "assistant-1",
        role: "assistant",
        content: "Hello! How can I help you today?",
      },
      {
        id: "user-2",
        role: "user",
        content: "hey",
      },
      {
        id: "assistant-2",
        role: "assistant",
        content: "I read the README and summarized it.",
      },
    ] satisfies Message[]);

    expect(turns).toHaveLength(2);
    expect(turns[0]?.key).toBe("user-1");
    expect(turns[0]?.userMessage?.id).toBe("user-1");
    expect(turns[0]?.assistantMessage?.id).toBe("assistant-1");
    expect(turns[1]?.key).toBe("user-2");
    expect(turns[1]?.userMessage?.id).toBe("user-2");
    expect(turns[1]?.assistantMessage?.id).toBe("assistant-2");
  });

  it("promotes a live user turn to the canonical assistant turn id", () => {
    const turns = buildConversationTurns([
      {
        id: "client-user",
        role: "user",
        content: "Read README",
      },
      {
        id: "server-assistant",
        role: "assistant",
        content: "Done",
        data: {
          metadata: {
            canonicalIdentity: {
              turnId: "trn_liveturn01",
            },
          },
        },
      },
    ] as Message[]);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.turnId).toBe("trn_liveturn01");
  });

  it("keeps the latest assistant message for a user turn when progress chatter streams first", () => {
    const turns = buildConversationTurns([
      {
        id: "user-1",
        role: "user",
        content: "update the workflow ui",
      },
      {
        id: "assistant-progress-1",
        role: "assistant",
        content: "I'm checking the current renderer first.",
      },
      {
        id: "assistant-progress-2",
        role: "assistant",
        content: "I've narrowed it down to the workflow lane.",
      },
      {
        id: "assistant-final",
        role: "assistant",
        content: "I updated the workflow UI to match the new compact design.",
      },
    ] satisfies Message[]);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.userMessage?.id).toBe("user-1");
    expect(turns[0]?.assistantMessage?.id).toBe("assistant-final");
  });

  it("projects replayed message ids once and keeps their latest payload", () => {
    const turns = buildConversationTurns([
      {
        id: "client_msg_same",
        role: "user",
        content: "hello",
      },
      {
        id: "assistant-same",
        role: "assistant",
        content: "partial",
      },
      {
        id: "client_msg_same",
        role: "user",
        content: "hello",
      },
      {
        id: "assistant-same",
        role: "assistant",
        content: "Hello! How can I help?",
      },
    ] satisfies Message[]);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.userMessage?.id).toBe("client_msg_same");
    expect(turns[0]?.assistantMessage).toMatchObject({
      id: "assistant-same",
      content: "Hello! How can I help?",
    });
  });

  it("uses persisted canonical turn identity and excludes commentary transcript rows", () => {
    const canonicalIdentity = {
      workspaceId: "wsp_metadata01",
      threadId: "thr_metadata01",
      turnId: "trn_metadata01",
      runAttemptId: "attempt_metadata01",
    };
    const turns = buildConversationTurns([
      {
        id: "user-1",
        role: "user",
        content: "Read README.md",
        data: { metadata: { canonicalIdentity } },
      },
      {
        id: "commentary-1",
        role: "assistant",
        content: "I’m reading the file.",
        data: { metadata: { canonicalIdentity, phase: "commentary" } },
      },
      {
        id: "assistant-1",
        role: "assistant",
        content: "The README is clear.",
        data: { metadata: { canonicalIdentity, phase: "final_answer" } },
      },
    ] as Message[]);

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      turnId: "trn_metadata01",
      userMessage: { id: "user-1" },
      assistantMessage: { id: "assistant-1" },
    });
  });

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
