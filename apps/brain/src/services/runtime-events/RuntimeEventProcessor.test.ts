import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  RUN_EVENT_TYPES,
  type InternalRuntimeEventRequest,
} from "@repo/shared-types";
import { RuntimeEventProcessor } from "./RuntimeEventProcessor";
import type { Env } from "../../types/ai";

const writeRunProjection = vi.hoisted(() => vi.fn());

vi.mock("../PersistenceService", () => ({
  PersistenceService: class {
    writeRunProjection = writeRunProjection;
  },
}));

describe("RuntimeEventProcessor", () => {
  beforeEach(() => {
    writeRunProjection.mockReset();
  });

  it("ignores secure-agent task lifecycle envelopes that are not canonical run events", async () => {
    const processor = new RuntimeEventProcessor({} as Env);
    const event: InternalRuntimeEventRequest = {
      source: "secure-agent-api",
      eventType: "runtime.task.started",
      idempotencyKey: "run-1:sess-local:task-1:runtime.task.started",
      payloadSchemaVersion: 1,
      payload: {
        runId: "123e4567-e89b-42d3-a456-426614174000",
        sessionId: "sess_177929052539_63810617c0a756ec",
        taskId: "git-status",
        action: "git.status",
      },
    };

    await processor.process(event);

    expect(writeRunProjection).not.toHaveBeenCalled();
  });

  it("persists step-bearing run events with one projection write", async () => {
    const processor = new RuntimeEventProcessor({} as Env);
    const event: InternalRuntimeEventRequest = {
      source: "secure-agent-api",
      eventType: RUN_EVENT_TYPES.TOOL_REQUESTED,
      idempotencyKey: "run_abc:tool-1:requested",
      payloadSchemaVersion: 1,
      payload: {
        version: 1,
        eventId: "event-tool-requested",
        runId: "run_abc",
        sessionId: "11111111-1111-4111-8111-111111111111",
        timestamp: "2026-06-27T09:00:00.000Z",
        source: "brain",
        type: RUN_EVENT_TYPES.TOOL_REQUESTED,
        payload: {
          toolId: "tool-1",
          toolName: "read_file",
          arguments: { path: "README.md" },
        },
      },
    };

    await processor.process(event);

    expect(writeRunProjection).toHaveBeenCalledTimes(1);
    expect(writeRunProjection).toHaveBeenCalledWith({
      event: expect.objectContaining({
        runId: "run_abc",
        eventType: RUN_EVENT_TYPES.TOOL_REQUESTED,
        payload: event.payload,
        idempotencyKey: "run_abc:tool-1:requested",
      }),
      step: expect.objectContaining({
        runId: "run_abc",
        stepIndex: 0,
        stepType: RUN_EVENT_TYPES.TOOL_REQUESTED,
        status: "pending",
      }),
      status: undefined,
    });
  });
});
