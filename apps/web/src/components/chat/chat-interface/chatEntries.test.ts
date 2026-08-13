import type { Message } from "@ai-sdk/react";
import { describe, expect, it } from "vitest";
import { buildConversationTurns } from "../messageMetadata";
import { buildChatEntries } from "./chatEntries";
import { createLifecycleProjection } from "../../../services/lifecycle/LifecycleProjection";
import { TurnIdSchema } from "@repo/platform-client-sdk";

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

  it("keeps canonical final output in its workflow instead of duplicating transcript output", () => {
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
      assistantText: "Done",
      terminal: {
        state: "completed" as const,
        eventId: "evt_entries01",
        content: "Done",
        occurredAt: "2026-06-25T00:00:01.000Z",
      },
    };

    expect(
      buildChatEntries(buildConversationTurns([user, assistant]), {
        [turnId]: projection,
      }).map((entry) =>
        entry.kind === "message" ? entry.message.id : entry.kind,
      ),
    ).toEqual(["user-1", "workflow"]);
  });

  it("uses terminal summary as canonical final output when assistant deltas are absent", () => {
    const turnId = TurnIdSchema.parse("trn_summaryonly01");
    const user = withTurnIdentity(
      createMessage("user-summary", "user", "Inspect the repo"),
      turnId,
    );
    const assistant = withTurnIdentity(
      createMessage("assistant-summary", "assistant", "Done from transcript"),
      turnId,
    );
    const projection = {
      ...createLifecycleProjection(turnId),
      lastSequence: 2,
      assistantText: "",
      terminal: {
        state: "completed" as const,
        eventId: "evt_summaryonly01",
        content: "Done from canonical terminal",
        occurredAt: "2026-06-25T00:00:01.000Z",
      },
    };

    const entries = buildChatEntries(
      buildConversationTurns([user, assistant]),
      { [turnId]: projection },
    );

    expect(
      entries.map((entry) =>
        entry.kind === "message" ? entry.message.id : entry.kind,
      ),
    ).toEqual(["user-summary", "workflow"]);
    expect(entries[1]).toMatchObject({
      kind: "workflow",
      assistantMessage: { id: "assistant-summary" },
    });
  });

  it("keeps the active canonical workflow visible while transcript identity catches up", () => {
    const turnId = TurnIdSchema.parse("trn_activegap01");
    const user = createMessage("user-1", "user", "Inspect the repo");
    const projection = {
      ...createLifecycleProjection(turnId),
      lastSequence: 1,
      phase: "working" as const,
    };

    expect(
      buildChatEntries(
        buildConversationTurns([user]),
        { [turnId]: projection },
        turnId,
      ).map((entry) =>
        entry.kind === "message" ? entry.message.id : entry.turnId,
      ),
    ).toEqual(["user-1", turnId]);
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
