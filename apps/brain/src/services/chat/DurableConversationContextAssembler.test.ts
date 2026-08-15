import { describe, expect, it, vi } from "vitest";
import {
  LifecycleEventSchema,
  type LifecycleEvent,
} from "@repo/platform-protocol";
import type { TranscriptMessageRecord } from "@repo/persistence";
import type { Env } from "../../types/ai";
import { DurableConversationContextAssembler } from "./DurableConversationContextAssembler";

describe("DurableConversationContextAssembler", () => {
  it("restores transcript and prior failed tool progress before the new prompt", async () => {
    const transcript = [
      message("old-user", "user", "Inspect the repository", "trn_prior001", 1),
      message("old-error", "assistant", "The run failed", undefined, 2),
      message("new-user", "user", "Continue the work", "trn_current01", 3),
    ];
    const replayLifecyclePage = vi.fn(async () => ({
      events: failedTurnEvents(),
      nextSequence: null,
    }));
    const assembler = new DurableConversationContextAssembler({} as Env, {
      readTranscriptPage: async () => ({
        messages: transcript,
        nextCursor: null,
      }),
      replayLifecyclePage,
    });

    const context = await assembler.assemble({
      sessionId: "session-1",
      userId: "user-1",
      currentTurnId: "trn_current01",
    });

    expect(context.map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
      "system",
      "user",
    ]);
    expect(context[2]?.content).toContain("Read package.json");
    expect(context[2]?.content).toContain("package shadowbox");
    expect(context.at(-1)?.content).toBe("Continue the work");
    expect(replayLifecyclePage).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: "trn_prior001" }),
    );
  });
});

function message(
  id: string,
  role: TranscriptMessageRecord["role"],
  text: string,
  turnId: string | undefined,
  sequence: number,
): TranscriptMessageRecord {
  return {
    id,
    sessionId: "session-1",
    runId: "run-1",
    role,
    clientMessageId: null,
    createdAt: "2026-08-12T00:00:00.000Z",
    parts: [
      {
        id: `part-${id}`,
        messageId: id,
        sessionId: "session-1",
        runId: "run-1",
        type: "text",
        sessionSequence: sequence,
        content: {
          text,
          ...(turnId ? { metadata: { canonicalIdentity: { turnId } } } : {}),
        },
        createdAt: "2026-08-12T00:00:00.000Z",
      },
    ],
  };
}

function failedTurnEvents(): LifecycleEvent[] {
  return [
    event(1, "tool_call.started", {
      itemId: "itm_prior001_read",
      toolCallId: "toolcall_prior001_read",
      payload: {
        display: {
          title: "Read package.json",
          family: "read",
          namespace: "read_file",
        },
      },
    }),
    event(2, "tool_call.output_delta", {
      itemId: "itm_prior001_read",
      toolCallId: "toolcall_prior001_read",
      payload: { output: "package shadowbox" },
    }),
    event(3, "tool_call.completed", {
      itemId: "itm_prior001_read",
      toolCallId: "toolcall_prior001_read",
      payload: { result: {} },
    }),
    event(4, "turn.failed", {
      payload: {
        outcome: {
          status: "failed",
          failure: {
            code: "provider_unavailable",
            message: "provider timed out",
            retryable: true,
            correlationId: null,
            details: null,
          },
        },
      },
    }),
  ];
}

function event(
  sequence: number,
  type: LifecycleEvent["type"],
  fields: Record<string, unknown>,
): LifecycleEvent {
  return LifecycleEventSchema.parse({
    eventId: `evt_prior001_${sequence}`,
    threadId: "thr_prior001",
    turnId: "trn_prior001",
    runAttemptId: "attempt_prior001",
    sequence,
    idempotencyKey: `prior:${sequence}`,
    producer: { kind: "runtime_kernel", id: "test" },
    schemaVersion: 1,
    createdAt: `2026-08-12T00:00:0${sequence}.000Z`,
    type,
    ...fields,
  });
}
