import type { Message } from "@ai-sdk/react";
import { describe, expect, it } from "vitest";
import type { LifecycleProjectionItem } from "@legioncode/sdk";
import { buildConversationTurns } from "@legioncode/sdk";
import { buildChatEntries } from "./chatEntries.js";
import { createLifecycleProjection } from "@legioncode/sdk";
import { TurnIdSchema } from "@legioncode/sdk";
import { ItemIdSchema } from "@legioncode/sdk";

describe("buildChatEntries", () => {
  it("preserves canonical transcript order", () => {
    const user = createMessage("user-1", "user", "Inspect the repo");
    const assistant = createMessage("assistant-1", "assistant", "Done");

    expect(buildChatEntries(buildConversationTurns([user, assistant]))).toEqual(
      [
        { kind: "message", message: user },
        { kind: "message", message: assistant },
      ],
    );
  });

  it("preserves durable assistant text from a failed turn", () => {
    const user = createMessage("user-1", "user", "Inspect the repo");
    const failed = {
      ...createMessage("assistant-1", "assistant", "failed"),
      data: { metadata: { terminalState: "failed" } },
    } as Message;

    expect(buildChatEntries(buildConversationTurns([user, failed]))).toEqual([
      { kind: "message", message: user },
      { kind: "message", message: failed },
    ]);
  });

  it("keeps canonical final output in its workflow instead of duplicating transcript output", () => {
    const turnId = TurnIdSchema.parse("trn_entries01");
    const user = withTurnIdentity(
      createMessage("user-1", "user", "Inspect the repo"),
      turnId,
    );
    const assistant = withTranscriptIdentity(
      createMessage("assistant-1", "assistant", "Done"),
      turnId,
      "itm_entries01",
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
      items: [assistantItem("itm_entries01")],
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
    ).toEqual(["user-summary", "workflow", "assistant-summary"]);
    expect(entries[1]).toMatchObject({
      kind: "workflow",
      assistantMessage: { id: "assistant-summary" },
    });
  });

  it.each([
    { name: "assistant text exact match", terminalContent: "Unused", storedText: "  Done from canonical  ", expected: false },
    { name: "terminal fallback exact match", assistantText: "", expected: false },
    { name: "substring remains visible", storedText: "Done from", expected: true },
    { name: "different final remains visible", storedText: "Older answer", expected: true },
    { name: "another turn remains visible", messageTurnId: "trn_otherhistorical01", expected: true },
    { name: "commentary remains visible", phase: "commentary", expected: true },
    { name: "unreplayed text remains visible", lastSequence: 0, expected: true },
    { name: "non-completed projection remains visible", terminalState: "interrupted" as const, expected: true },
    { name: "explicit failed row remains visible", storedTerminalState: "failed", expected: true },
    { name: "explicit interrupted row remains visible", storedTerminalState: "interrupted", expected: true },
  ])("$name", (testCase) => {
    const canonicalFinal = "Done from canonical";
    const assistantText = testCase.assistantText ?? canonicalFinal;
    const terminalContent = testCase.terminalContent ?? canonicalFinal;
    const turnId = TurnIdSchema.parse("trn_historicalfinal01");
    const user = withTurnIdentity(
      createMessage("user-historical", "user", "Inspect the repo"),
      turnId,
    );
    const assistant = withTurnIdentity(
      createMessage(
        "assistant-historical",
        "assistant",
        testCase.storedText ?? canonicalFinal,
      ),
      testCase.messageTurnId ?? turnId,
    ) as Message & { data: { metadata: Record<string, unknown> } };
    assistant.data.metadata = {
      ...assistant.data.metadata,
      phase: testCase.phase ?? "final_answer",
      ...(testCase.storedTerminalState
        ? { terminalState: testCase.storedTerminalState }
        : {}),
    };
    const projection = {
      ...createLifecycleProjection(turnId),
      lastSequence: testCase.lastSequence ?? 1,
      assistantText,
      terminal: {
        state: testCase.terminalState ?? ("completed" as const),
        eventId: "evt_historicalfinal01",
        content: terminalContent,
        occurredAt: "2026-06-25T00:00:01.000Z",
      },
    };

    const entries = buildChatEntries(buildConversationTurns([user, assistant]), {
      [turnId]: projection,
    });
    expect(
      entries.some(
        (entry) =>
          entry.kind === "message" && entry.message.id === "assistant-historical",
      ),
    ).toBe(testCase.expected);
  });

  it.each([
    ["single item", "Checking the repository.", ["Checking the repository."], false, undefined, undefined],
    ["combined items", "Checking the repository.", ["Checking the ", "repository."], false, undefined, undefined],
    ["combined substring", "the repository", ["Checking the ", "repository."], true, undefined, undefined],
    ["wrong turn", "Checking the repository.", ["Checking the repository."], true, "trn_othercommentary01", undefined],
    ["failed turn", "Checking the repository.", ["Checking the repository."], true, undefined, "failed"],
  ] as const)(
    "historical commentary: %s",
    (_name, storedText, commentary, expected, messageTurnId, terminalState) => {
      const turnId = TurnIdSchema.parse("trn_historicalcommentary01");
      const user = withTurnIdentity(
        createMessage("user-commentary", "user", "Inspect the repo"),
        turnId,
      );
      const assistant = withTurnIdentity(
        createMessage("assistant-commentary", "assistant", storedText),
        messageTurnId ?? turnId,
      ) as Message & { data: { metadata: Record<string, unknown> } };
      assistant.data.metadata.phase = "commentary";
      const projection = {
        ...createLifecycleProjection(turnId),
        lastSequence: 1,
        terminal: {
          state: terminalState ?? ("completed" as const),
          eventId: "evt_historicalcommentary01",
          content: "Done",
          occurredAt: "2026-06-25T00:00:01.000Z",
        },
        items: commentary.map((text, index) =>
          commentaryItem(`itm_oldcommentary0${index + 1}`, text, index + 1),
        ),
      };

      const entries = buildChatEntries(
        buildConversationTurns([user, assistant]),
        { [turnId]: projection },
      );
      expect(
        entries.some(
          (entry) =>
            entry.kind === "message" &&
            entry.message.id === "assistant-commentary",
        ),
      ).toBe(expected);
    },
  );

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

function withTranscriptIdentity(
  message: Message,
  turnId: string,
  itemId: string,
): Message {
  const identified = withTurnIdentity(message, turnId) as Message & {
    data: { metadata: Record<string, unknown> };
  };
  return {
    ...identified,
    data: {
      metadata: { ...identified.data.metadata, itemId, phase: "final_answer" },
    },
  } as Message;
}

function assistantItem(itemId: string) {
  return {
    itemId: ItemIdSchema.parse(itemId),
    sequence: 1,
    kind: "assistant_message" as const,
    status: "completed" as const,
    text: "Done",
    detail: null,
    toolFamily: null,
    safeSummary: null,
    inputSummary: null,
    outputSummary: null,
    toolName: null,
    filePath: null,
    command: null,
    outputContent: null,
    diffPreview: null,
    additions: null,
    deletions: null,
    planSteps: [],
    compactionPhase: null,
    startedAt: "2026-06-25T00:00:00.000Z",
    completedAt: "2026-06-25T00:00:01.000Z",
  };
}

function commentaryItem(itemId: string, text: string, sequence: number) {
  return {
    ...assistantItem(itemId),
    sequence,
    kind: "commentary" as const,
    text,
  };
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
