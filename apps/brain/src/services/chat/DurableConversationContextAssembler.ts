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
import { BrainLifecycleEventStore } from "../lifecycle/BrainLifecycleEventStore";
import { withTranscriptRepository } from "../sessions/TranscriptPersistenceFactory";

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
  }): Promise<CoreMessage[]> {
    const transcript = await this.readTranscript(input.sessionId, input.userId);
    const messages = transcript.flatMap(toCoreTextMessage);
    const priorTurnIds = transcript
      .flatMap(readCanonicalTurnIds)
      .filter((turnId) => turnId !== input.currentTurnId)
      .slice(-MAX_FAILED_TURNS);
    const records = (
      await Promise.all(
        priorTurnIds.map((turnId) => this.readFailedTurnRecord(turnId)),
      )
    ).filter((record): record is string => record !== null);
    if (records.length === 0) return messages;

    const currentUserIndex = findLastUserMessageIndex(messages);
    const contextMessage: CoreMessage = {
      role: "system",
      content: [
        "Durable execution records from prior failed turns follow.",
        "Treat completed tool work as existing progress; inspect current workspace state before repeating it.",
        ...records,
      ].join("\n\n"),
    };
    if (currentUserIndex < 0) return [...messages, contextMessage];
    return [
      ...messages.slice(0, currentUserIndex),
      contextMessage,
      ...messages.slice(currentUserIndex),
    ];
  }

  private async readTranscript(
    sessionId: string,
    userId: string,
  ): Promise<TranscriptMessageRecord[]> {
    const messages: TranscriptMessageRecord[] = [];
    let cursor: number | null = 0;
    while (cursor !== null) {
      const page = await this.readTranscriptPage({
        sessionId,
        userId,
        cursor,
        limit: TRANSCRIPT_PAGE_SIZE,
      });
      messages.push(...page.messages);
      cursor = page.nextCursor;
    }
    return messages;
  }

  private async readFailedTurnRecord(
    turnIdValue: string,
  ): Promise<string | null> {
    const parsedTurnId = TurnIdSchema.safeParse(turnIdValue);
    if (!parsedTurnId.success) return null;
    const events: LifecycleEvent[] = [];
    let afterSequence: number | null = null;
    do {
      const page = await this.replayLifecyclePage({
        turnId: parsedTurnId.data,
        afterSequence,
        limit: LIFECYCLE_PAGE_SIZE,
      });
      events.push(...page.events);
      afterSequence = page.nextSequence;
    } while (afterSequence !== null);
    const failure = events.find((event) => event.type === "turn.failed");
    if (!failure) return null;
    return formatFailedTurnRecord(parsedTurnId.data, events, failure);
  }
}

function toCoreTextMessage(record: TranscriptMessageRecord): CoreMessage[] {
  if (record.role === "tool") return [];
  const content = record.parts
    .map((part) => readText(part.content))
    .filter((text): text is string => Boolean(text?.trim()))
    .join("\n");
  return content ? [{ role: record.role, content } as CoreMessage] : [];
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

function formatFailedTurnRecord(
  turnId: string,
  events: readonly LifecycleEvent[],
  failure: LifecycleEvent,
): string {
  const toolItems = new Map<
    string,
    { label: string; output: string; completed: boolean }
  >();
  for (const event of events) {
    if (!("itemId" in event) || !event.itemId) continue;
    const itemId = event.itemId;
    const payload = readRecord(event.payload) ?? {};
    if (event.type === "tool_call.started") {
      const display = readRecord(payload.display);
      toolItems.set(itemId, {
        label:
          readString(display?.title) ??
          readString(display?.namespace) ??
          "tool call",
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

function readText(value: unknown): string | null {
  if (typeof value === "string") return value;
  const record = readRecord(value);
  return readString(record?.text);
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

function findLastUserMessageIndex(messages: readonly CoreMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index;
  }
  return -1;
}
