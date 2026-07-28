import type { Message } from "@ai-sdk/react";
import { describe, expect, it } from "vitest";
import { buildConversationTurns } from "../messageMetadata";
import { buildChatEntries } from "./chatEntries";
import { createLifecycleProjection } from "../../../services/lifecycle/LifecycleProjection";
import { TurnIdSchema } from "@repo/platform-protocol";

describe("buildChatEntries", () => {
  it("preserves canonical transcript order", () => {
    const user = createMessage("user-1", "user", "Inspect the repo");
    const assistant = createMessage("assistant-1", "assistant", "Done");

    expect(buildChatEntries(buildConversationTurns([user, assistant]))).toEqual([
      { kind: "message", message: user },
      { kind: "message", message: assistant },
    ]);
  });

  it("does not render failed assistant text as a completed transcript answer", () => {
    const user = createMessage("user-1", "user", "Inspect the repo");
    const failed = {
      ...createMessage("assistant-1", "assistant", "failed"),
      data: { metadata: { terminalState: "failed" } },
    } as Message;

    expect(buildChatEntries(buildConversationTurns([user, failed]))).toEqual([
      { kind: "message", message: user },
    ]);
  });

  it("places canonical workflow between its user prompt and final answer", () => {
    const turnId = TurnIdSchema.parse("trn_entries01");
    const user = withTurnIdentity(
      createMessage("user-1", "user", "Inspect the repo"),
      turnId,
    );
    const assistant = withTurnIdentity(
      createMessage("assistant-1", "assistant", "Done"),
      turnId,
    );
    const projection = {
      ...createLifecycleProjection(turnId),
      lastSequence: 1,
    };

    expect(
      buildChatEntries(buildConversationTurns([user, assistant]), {
        [turnId]: projection,
      }).map((entry) =>
        entry.kind === "message" ? entry.message.id : entry.kind,
      ),
    ).toEqual(["user-1", "workflow", "assistant-1"]);
  });
});

function withTurnIdentity(message: Message, turnId: string): Message {
  return {
    ...message,
    data: {
      metadata: {
        canonicalIdentity: {
          workspaceId: "wsp_entries01",
          threadId: "thr_entries01",
          turnId,
          runAttemptId: "attempt_entries01",
        },
      },
    },
  } as Message;
}

function createMessage(
  id: string,
  role: "user" | "assistant",
  content: string,
): Message {
  return {
    id,
    role,
    content,
    createdAt: new Date("2026-06-25T00:00:00.000Z"),
  } as Message;
}
