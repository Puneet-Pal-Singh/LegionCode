import { appServerJsonByteLength, LifecycleEventSchema, type LifecycleEvent } from "@repo/platform-protocol";
import { RuntimeKernelError } from "./errors.js";
import type { RuntimeLifecycleEventStore } from "./ports.js";
import type { StartTurnInput, StartTurnResult } from "./types.js";

const PAGE_SIZE = 128;
const MAX_EVENTS = 10_000;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_HISTORY_BYTES = 8 * 1024 * 1024;

/** A completed Native retry is answered entirely from its immutable stream. */
export async function readCompletedTurnReplay(
  store: RuntimeLifecycleEventStore,
  input: StartTurnInput,
  producerId: string,
  first: LifecycleEvent,
): Promise<StartTurnResult> {
  const events = [first];
  let cursor = first.sequence;
  let bytes = appServerJsonByteLength(first);
  while (events.length <= MAX_EVENTS) {
    const page = await store.replay({ turnId: input.turn.id, afterSequence: cursor, limit: PAGE_SIZE, maxBytes: MAX_PAGE_BYTES });
    if (!Array.isArray(page.events) || page.events.length > PAGE_SIZE) throw invalidHistory();
    if (page.events.length === 0) {
      if (page.nextSequence !== null) throw invalidHistory();
      break;
    }
    for (const raw of page.events) {
      const event = LifecycleEventSchema.safeParse(raw);
      if (!event.success || event.data.sequence !== cursor + 1) throw invalidHistory();
      bytes += appServerJsonByteLength(event.data);
      if (bytes > MAX_HISTORY_BYTES) throw invalidHistory();
      events.push(event.data);
      cursor = event.data.sequence;
    }
    if (page.nextSequence !== cursor) throw invalidHistory();
  }

  const [, started, attemptStarted] = events;
  if (
    events.length > MAX_EVENTS || cursor < input.turn.lastEventSequence ||
    first.type !== "turn.queued" || started?.type !== "turn.started" ||
    attemptStarted?.type !== "run_attempt.started" ||
    started.payload.revisionOfTurnId !== (input.turn.parentTurnId ?? undefined) ||
    started.payload.continuationOfTurnId !== input.continuationOfTurnId ||
    started.payload.originalPromptId !== input.originalPromptId ||
    attemptStarted.payload.executionCapability !== input.run.executionCapability ||
    events.some((event) => event.turnId !== input.turn.id || event.threadId !== input.run.threadId ||
      event.runAttemptId !== input.runAttemptId || event.producer.kind !== "runtime_kernel" || event.producer.id !== producerId)
  ) throw invalidHistory();

  const terminal = events.at(-1);
  if (terminal?.type !== "turn.completed") {
    throw new RuntimeKernelError("turn_already_owned", "Canonical lifecycle history requires explicit supported recovery");
  }
  if (events.at(-2)?.type !== "run_attempt.succeeded" || events.slice(0, -2).some((event) =>
    event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.interrupted" ||
    event.type === "run_attempt.succeeded" || event.type === "run_attempt.failed" || event.type === "run_attempt.interrupted")) {
    throw invalidHistory();
  }

  const item = events.at(-3);
  if (item?.type !== "item.completed" || typeof item.payload.result.output !== "string") throw invalidHistory();
  const fragments: string[] = [];
  let index = events.length - 4;
  for (; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "assistant_message.delta") break;
    if (event.itemId !== item.itemId || event.payload.phase !== "final_answer" ||
      typeof event.payload.delta !== "string") throw invalidHistory();
    fragments.push(event.payload.delta);
  }
  const opened = events[index];
  if (!fragments.length || opened?.type !== "item.started" || opened.itemId !== item.itemId ||
    opened.payload.kind !== "assistant_message" ||
    fragments.reverse().join("") !== item.payload.result.output) throw invalidHistory();
  return {
    status: "completed",
    output: item.payload.result.output,
    toolCallCount: events.filter((event) => event.type === "tool_call.started").length,
    workspace: null,
  };
}

function invalidHistory(): RuntimeKernelError {
  return new RuntimeKernelError("invalid_turn_identity", "Canonical terminal replay has incomplete or mismatched evidence");
}
