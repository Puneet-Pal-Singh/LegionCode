import type { CoreMessage } from "ai";
import { TurnIdSchema, type LifecycleEvent } from "@repo/platform-protocol";
import type { TranscriptMessageRecord } from "@repo/persistence";
import type {
  ListTranscriptInput,
  ListTranscriptResult,
  ReplayLifecycleEventsInput,
  ReplayLifecycleEventsResult,
} from "@repo/persistence";
import type { Env } from "../../types/ai";
import {
  normalizeTaskToolSequence,
  projectLifecycleToolMessages,
  projectTaskContext,
} from "@legioncode/execution-engine/runtime/engine";
import { BrainLifecycleEventStore } from "../lifecycle/BrainLifecycleEventStore";
import { withTranscriptRepository } from "../sessions/TranscriptPersistenceFactory";
import { projectActiveTranscriptBranch } from "./TranscriptBranchProjection";
import {
  restoreTranscriptMessage,
  readTranscriptImageAttachments,
} from "./TranscriptImageAttachments";
import {
  assertChatImageModelSupport,
  type ChatImageModelMetadata,
} from "./ChatImageModelPolicy";

const TRANSCRIPT_PAGE_SIZE = 100;
const LIFECYCLE_PAGE_SIZE = 1_000;
const MAX_FAILED_TURNS = 4;
const MAX_TOOL_RECORDS_PER_TURN = 16;
const MAX_TOOL_OUTPUT_CHARS = 600;

/** Builds model context from durable transcript and lifecycle truth. */
export class DurableConversationContextAssembler {
  private readonly readTranscriptPage: (
    input: ListTranscriptInput,
  ) => Promise<ListTranscriptResult>;
  private readonly replayLifecyclePage: (
    input: ReplayLifecycleEventsInput,
  ) => Promise<ReplayLifecycleEventsResult>;

  constructor(
    private readonly env: Env,
    dependencies: {
      readTranscriptPage?: (
        input: ListTranscriptInput,
      ) => Promise<ListTranscriptResult>;
      replayLifecyclePage?: (
        input: ReplayLifecycleEventsInput,
      ) => Promise<ReplayLifecycleEventsResult>;
    } = {},
  ) {
    this.readTranscriptPage =
      dependencies.readTranscriptPage ??
      ((input) =>
        withTranscriptRepository(this.env, (repository) =>
          repository.listTranscript(input),
        ));
    const lifecycleStore = new BrainLifecycleEventStore(this.env);
    this.replayLifecyclePage =
      dependencies.replayLifecyclePage ??
      ((input) => lifecycleStore.replay(input));
  }

  async assemble(input: {
    sessionId: string;
    userId: string;
    currentTurnId: string;
    revisionOfTurnId?: string;
    continuationOfTurnId?: string;
    /** Canonical original user-message ID for a continuation turn. */
    originalPromptId?: string;
    imageModelMetadata?: ChatImageModelMetadata;
  }): Promise<CoreMessage[]> {
    const { messages: durableTranscript, supersededTurnIds } = await this.readTranscript(
      input.sessionId,
      input.userId,
    );
    const lifecycleByTurn = await this.readLifecycleEvents(durableTranscript, [
      input.currentTurnId,
      ...(input.continuationOfTurnId ? [input.continuationOfTurnId] : []),
      ...(input.revisionOfTurnId ? [input.revisionOfTurnId] : []),
    ]);
    const lifecycleEvents = [...lifecycleByTurn.values()].flat();
    const acceptedInputs = readAcceptedInputReceipts(lifecycleEvents);
    const transcript = projectActiveTranscriptBranch(
      durableTranscript.filter((record) => {
        const inputId = readCanonicalInputId(record);
        if (!inputId) return true;
        const turnId = readCanonicalTurnId(record);
        const receipt = turnId ? acceptedInputs.get(turnId)?.get(inputId) : undefined;
        return !!receipt && receipt.transcriptMessageId === (record.clientMessageId ?? record.id);
      }),
      [
        ...supersededTurnIds,
        ...(input.revisionOfTurnId ? [input.revisionOfTurnId] : []),
      ],
      lifecycleEvents,
    );
    const timeline: Array<{
      createdAt: string;
      order: number;
      messages: CoreMessage[];
    }> = [];
    let timelineOrder = 0;
    for (const record of transcript) {
      if (readTranscriptImageAttachments(record).length > 0) {
        assertChatImageModelSupport(input.imageModelMetadata ?? {});
      }
      const restored = await restoreTranscriptMessage({
        env: this.env,
        record,
        userId: input.userId,
        sessionId: input.sessionId,
      });
      if (restored.length > 0) {
        timeline.push({
          createdAt: record.createdAt,
          order: timelineOrder++,
          messages: restored,
        });
      }
    }
    const activeTurnIds = new Set([
      ...transcript.flatMap(readCanonicalTurnIds),
      input.currentTurnId,
      ...(input.continuationOfTurnId ? [input.continuationOfTurnId] : []),
    ]);
    const continuationAncestors = [
      input.currentTurnId,
      ...(input.continuationOfTurnId ? [input.continuationOfTurnId] : []),
    ];
    const visitedContinuationTurns = new Set<string>();
    while (continuationAncestors.length > 0) {
      const turnId = continuationAncestors.pop()!;
      if (visitedContinuationTurns.has(turnId)) continue;
      visitedContinuationTurns.add(turnId);
      for (const event of lifecycleByTurn.get(turnId) ?? []) {
        if (
          event.type === "turn.started" &&
          event.payload.continuationOfTurnId
        ) {
          activeTurnIds.add(event.payload.continuationOfTurnId);
          continuationAncestors.push(event.payload.continuationOfTurnId);
        }
      }
    }
    const activeLifecycleEvents = lifecycleEvents.filter((event) =>
      activeTurnIds.has(event.turnId),
    );
    for (const group of projectLifecycleToolMessages(
      activeLifecycleEvents,
      timeline.flatMap((entry) => entry.messages),
    )) {
      if (group.mergeIntoMessageId) {
        const targetIndex = timeline.findIndex((entry) =>
          entry.messages.some((message) => readMessageId(message) === group.mergeIntoMessageId),
        );
        const target = timeline[targetIndex];
        const assistantAdditions = group.messages.find(
          (message) => message.role === "assistant",
        );
        const toolResults = group.messages.find((message) => message.role === "tool");
        if (target && targetIndex >= 0) {
          if (assistantAdditions) {
            target.messages = target.messages.map((message) =>
              readMessageId(message) === group.mergeIntoMessageId
                ? {
                    ...message,
                    content: [
                      ...(Array.isArray(message.content) ? message.content : []),
                      ...(Array.isArray(assistantAdditions.content)
                        ? assistantAdditions.content
                        : []),
                    ],
                  } as CoreMessage
                : message,
            );
          }
          if (toolResults) {
            const next = timeline[targetIndex + 1];
            const existingTool = next?.messages.find((message) => message.role === "tool");
            if (next && existingTool && Array.isArray(existingTool.content)) {
              next.messages = next.messages.map((message) =>
                message === existingTool
                  ? {
                      ...message,
                      content: [
                        ...existingTool.content,
                        ...(Array.isArray(toolResults.content) ? toolResults.content : []),
                      ],
                    } as CoreMessage
                  : message,
              );
            } else {
              timeline.splice(targetIndex + 1, 0, {
                createdAt: target.createdAt,
                order: target.order + 0.5,
                messages: [toolResults],
              });
            }
          }
          continue;
        }
      }
      timeline.push({
        createdAt: group.createdAt,
        order: timelineOrder++,
        messages: [...group.messages],
      });
    }
    timeline.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.order - right.order);
    const normalizedMessages = normalizeTaskToolSequence(
      timeline.flatMap((entry) => entry.messages),
      { requireToolNameMatch: true },
    );
    const currentRootPrompt = input.originalPromptId
      ? transcript.find(
          (record) =>
            record.role === "user" &&
            (record.id === input.originalPromptId ||
              record.clientMessageId === input.originalPromptId),
        )
      : [...transcript]
          .reverse()
          .find(
            (record) =>
              record.role === "user" &&
              readCanonicalTurnIds(record).includes(input.currentTurnId),
          );
    const rootPromptId = currentRootPrompt
      ? currentRootPrompt.clientMessageId ?? currentRootPrompt.id
      : undefined;
    if (!rootPromptId) {
      throw new Error(
        input.originalPromptId
          ? "The durable transcript is missing the continuation's original root prompt."
          : "The durable transcript is missing the current turn's root prompt.",
      );
    }
    const priorTurnIds = transcript
      .flatMap(readCanonicalTurnIds)
      .filter((turnId) => turnId !== input.currentTurnId)
      .slice(-MAX_FAILED_TURNS);
    const records = priorTurnIds
      .map((turnId) =>
        formatFailedTurnRecordIfAny(turnId, lifecycleByTurn.get(turnId) ?? []),
      )
      .filter((record): record is string => record !== null);
    if (records.length === 0) return normalizedMessages;

    const projection = projectTaskContext({
      messages: normalizedMessages,
      rootPromptId,
    });
    const currentUserIndex = projection.activeTaskStartIndex;
    const contextMessage: CoreMessage = {
      role: "system",
      content: [
        "Durable execution records from prior failed turns follow.",
        "Treat completed tool work as existing progress; inspect current workspace state before repeating it.",
        ...records,
      ].join("\n\n"),
    };
    if (currentUserIndex >= projection.messages.length) {
      return [...projection.messages, contextMessage];
    }
    return [
      ...projection.background,
      contextMessage,
      ...projection.activeTask,
    ];
  }

  private async readTranscript(
    sessionId: string,
    userId: string,
  ): Promise<{ messages: TranscriptMessageRecord[]; supersededTurnIds: string[] }> {
    const messages: TranscriptMessageRecord[] = [];
    const supersededTurnIds = new Set<string>();
    let cursor: number | null = 0;
    let snapshot: number | null = null;
    while (cursor !== null) {
      const page = await this.readTranscriptPage({
        sessionId,
        userId,
        cursor,
        snapshot,
        limit: TRANSCRIPT_PAGE_SIZE,
      });
      if (snapshot === null) snapshot = page.snapshot;
      for (const turnId of page.supersededTurnIds) supersededTurnIds.add(turnId);
      messages.push(...page.messages);
      if (page.nextCursor !== null && page.nextCursor <= cursor) {
        throw new Error("Transcript pagination cursor did not advance");
      }
      cursor = page.nextCursor;
    }
    return { messages, supersededTurnIds: [...supersededTurnIds] };
  }

  private async readLifecycleEvents(
    transcript: readonly TranscriptMessageRecord[],
    additionalTurnIds: readonly string[] = [],
  ): Promise<Map<string, LifecycleEvent[]>> {
    const pendingTurnIds = new Set([
      ...transcript.flatMap(readCanonicalTurnIds),
      ...additionalTurnIds,
    ]);
    const byTurn = new Map<string, LifecycleEvent[]>();
    while (pendingTurnIds.size > 0) {
      const turnIds = [...pendingTurnIds].filter((turnId) => !byTurn.has(turnId));
      pendingTurnIds.clear();
      const pages = await Promise.all(
        turnIds.map(async (turnId) => {
        const parsedTurnId = TurnIdSchema.safeParse(turnId);
        if (!parsedTurnId.success) {
          return [turnId, [] as LifecycleEvent[]] as const;
        }
        const events = new Map<string, LifecycleEvent>();
        let afterSequence: number | null = null;
        do {
          const page = await this.replayLifecyclePage({
            turnId: parsedTurnId.data,
            afterSequence,
            limit: LIFECYCLE_PAGE_SIZE,
          });
          for (const event of page.events) {
            if (event.turnId === parsedTurnId.data) {
              events.set(event.eventId, event);
            }
          }
          if (
            page.nextSequence !== null &&
            afterSequence !== null &&
            page.nextSequence <= afterSequence
          ) {
            throw new Error("Lifecycle pagination cursor did not advance");
          }
          afterSequence = page.nextSequence;
        } while (afterSequence !== null);
        return [
          turnId,
          [...events.values()].sort((left, right) => left.sequence - right.sequence),
        ] as const;
        }),
      );
      for (const [turnId, events] of pages) {
        byTurn.set(turnId, events);
        for (const event of events) {
          if (event.type !== "turn.started") continue;
          const parentIds = [
            event.payload.continuationOfTurnId,
            event.payload.revisionOfTurnId,
          ];
          for (const parentId of parentIds) {
            if (parentId && !byTurn.has(parentId)) pendingTurnIds.add(parentId);
          }
        }
      }
    }
    return byTurn;
  }
}

function readAcceptedInputReceipts(
  events: readonly LifecycleEvent[],
): Map<string, Map<string, { transcriptMessageId: string }>> {
  const receipts = new Map<string, Map<string, { transcriptMessageId: string }>>();
  for (const event of events) {
    if (event.type !== "turn.input.accepted") continue;
    const turnReceipts = receipts.get(event.turnId) ?? new Map();
    turnReceipts.set(event.payload.inputId, {
      transcriptMessageId: event.payload.transcriptMessageId,
    });
    receipts.set(event.turnId, turnReceipts);
  }
  return receipts;
}

function readCanonicalTurnIds(record: TranscriptMessageRecord): string[] {
  if (record.role !== "user") return [];
  return record.parts.flatMap((part) => {
    const content = readRecord(part.content);
    const metadata = readRecord(content?.metadata);
    const identity = readRecord(metadata?.canonicalIdentity);
    return typeof identity?.turnId === "string" ? [identity.turnId] : [];
  });
}

function readCanonicalTurnId(record: TranscriptMessageRecord): string | null {
  return readCanonicalTurnIds(record)[0] ?? null;
}

function readCanonicalInputId(record: TranscriptMessageRecord): string | null {
  if (record.role !== "user") return null;
  for (const part of record.parts) {
    const content = readRecord(part.content);
    const metadata = readRecord(content?.metadata);
    const identity = readRecord(metadata?.canonicalIdentity);
    if (typeof identity?.inputId === "string") return identity.inputId;
  }
  return null;
}

function readMessageId(message: CoreMessage): string | null {
  const id = (message as CoreMessage & { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

function formatFailedTurnRecordIfAny(
  turnId: string,
  events: readonly LifecycleEvent[],
): string | null {
  const failure = events.find((event) => event.type === "turn.failed");
  if (!failure) return null;
  const toolItems = new Map<
    string,
    { label: string; output: string; completed: boolean }
  >();
  for (const event of events) {
    if (!("itemId" in event) || !event.itemId) continue;
    const itemId = event.itemId;
    const payload = readRecord(event.payload) ?? {};
    if (event.type === "tool_call.started") {
      toolItems.set(itemId, {
        label: readString(payload.toolName) ?? "tool call",
        output: "",
        completed: false,
      });
    } else if (event.type === "tool_call.output_delta") {
      const current = toolItems.get(itemId);
      if (!current) continue;
      current.output = redactContextDetail(
        `${current.output}${readString(payload.output) ?? ""}`,
      ).slice(-MAX_TOOL_OUTPUT_CHARS);
    } else if (event.type === "tool_call.completed") {
      const current = toolItems.get(itemId);
      if (current) current.completed = true;
  }
}
  const failurePayload = readRecord(failure.payload);
  const outcome = readRecord(failurePayload?.outcome);
  const failureDetail = readRecord(outcome?.failure);
  const lines = [...toolItems.values()]
    .filter((item) => item.completed)
    .slice(-MAX_TOOL_RECORDS_PER_TURN)
    .map(
      (item) =>
        `- completed ${item.label}${item.output.trim() ? `: ${item.output.trim()}` : ""}`,
    );
  return [
    `Failed turn ${turnId}: ${
      readString(outcome?.summary) ??
      readString(failureDetail?.message) ??
      "failed"
    }`,
    ...lines,
  ].join("\n");
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function redactContextDetail(value: string): string {
  return value
    .replace(/\b(sk|key|token)-[A-Za-z0-9_-]{12,}\b/gi, "[redacted]")
    .replace(
      /\b(authorization\s*:\s*bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi,
      "$1[redacted]",
    );
}

