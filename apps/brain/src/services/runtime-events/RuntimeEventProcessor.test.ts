import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InternalRuntimeEventRequest } from "@repo/shared-types";
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
});
