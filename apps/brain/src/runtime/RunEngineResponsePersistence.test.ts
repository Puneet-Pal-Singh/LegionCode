import type { DurableObjectState } from "@cloudflare/workers-types";
import { LifecycleEventSchema } from "@repo/platform-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersistenceService } from "../services/PersistenceService";
import type { Env } from "../types/ai";
import {
  persistAssistantMessageFromLifecycleEvent,
  persistAssistantMessageFromRunResponse,
} from "./RunEngineResponsePersistence";

const IDENTITY = {
  workspaceId: "wsp_123e4567e89b42d3a456426614174900",
  threadId: "thr_123e4567e89b42d3a456426614174900",
  turnId: "trn_123e4567e89b42d3a456426614174900",
  runAttemptId: "attempt_123e4567e89b42d3a456426614174900",
};

describe("canonical assistant transcript persistence", () => {
  afterEach(() => vi.restoreAllMocks());

  it("persists assistant deltas using the server-issued turn identity", async () => {
    const persistAssistantTurn = vi
      .spyOn(PersistenceService.prototype, "persistAssistantTurn")
      .mockResolvedValue({ id: "msg_assistant_1" } as never);
    const event = LifecycleEventSchema.parse({
      eventId: "evt_123e4567e89b42d3a456426614174900",
      threadId: IDENTITY.threadId,
      turnId: IDENTITY.turnId,
      runAttemptId: IDENTITY.runAttemptId,
      sequence: 3,
      idempotencyKey: `${IDENTITY.turnId}:3:assistant_message.delta`,
      producer: { kind: "runtime_kernel", id: "runtime-kernel" },
      schemaVersion: 1,
      createdAt: "2026-07-27T10:00:00.000Z",
      type: "assistant_message.delta",
      itemId: "itm_123e4567e89b42d3a456426614174900",
      payload: { delta: "README updated." },
    });

    await expect(
      persistAssistantMessageFromLifecycleEvent(
        {} as Env,
        "session-a",
        "run_123e4567e89b42d3a456426614174900",
        IDENTITY,
        event,
      ),
    ).resolves.toEqual({ assistantMessageId: "msg_assistant_1" });
    expect(persistAssistantTurn).toHaveBeenCalledWith({
      sessionId: "session-a",
      runId: "run_123e4567e89b42d3a456426614174900",
      turnId: IDENTITY.turnId,
      text: "README updated.",
      metadata: { canonicalIdentity: IDENTITY, phase: "final_answer" },
    });
  });

  it("does not reconstruct transcript content from the legacy response path", async () => {
    const persistAssistantTurn = vi.spyOn(
      PersistenceService.prototype,
      "persistAssistantTurn",
    );

    await expect(
      persistAssistantMessageFromRunResponse(
        {} as DurableObjectState,
        {} as Env,
        "session-a",
        "run_123e4567e89b42d3a456426614174900",
        "corr-1",
        new Response("legacy response text", { status: 400 }),
        IDENTITY,
      ),
    ).resolves.toBeNull();
    expect(persistAssistantTurn).not.toHaveBeenCalled();
  });

  it("ignores non-assistant lifecycle events", async () => {
    const persistAssistantTurn = vi.spyOn(
      PersistenceService.prototype,
      "persistAssistantTurn",
    );
    const event = LifecycleEventSchema.parse({
      eventId: "evt_123e4567e89b42d3a456426614174901",
      threadId: IDENTITY.threadId,
      turnId: IDENTITY.turnId,
      runAttemptId: IDENTITY.runAttemptId,
      sequence: 1,
      idempotencyKey: `${IDENTITY.turnId}:1:turn.started`,
      producer: { kind: "runtime_kernel", id: "runtime-kernel" },
      schemaVersion: 1,
      createdAt: "2026-07-27T10:00:00.000Z",
      type: "turn.started",
      payload: {},
    });

    await expect(
      persistAssistantMessageFromLifecycleEvent(
        {} as Env,
        "session-a",
        "run_123e4567e89b42d3a456426614174900",
        IDENTITY,
        event,
      ),
    ).resolves.toBeNull();
    expect(persistAssistantTurn).not.toHaveBeenCalled();
  });
});
