import { describe, expect, it } from "vitest";
import {
  INTERNAL_RUNTIME_EVENT_SIGNATURE_HEADER,
  INTERNAL_RUNTIME_EVENT_TIMESTAMP_HEADER,
} from "@repo/shared-types";
import { InternalRuntimeEventClient } from "./InternalRuntimeEventClient";

const NOW = 1778716800000;

describe("InternalRuntimeEventClient", () => {
  it("posts signed runtime events to Brain", async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const client = new InternalRuntimeEventClient({
      brain: {
        async fetch(input, init) {
          requests.push({ input, init });
          return Response.json({ accepted: true });
        },
      },
      secret: "runtime-event-secret",
      now: () => NOW,
    });

    await client.publish({
      source: "secure-agent-api",
      eventType: "runtime.task.started",
      idempotencyKey: "run-1:session-1:task-1:runtime.task.started",
      payloadSchemaVersion: 1,
      payload: {
        runId: "run-1",
        sessionId: "session-1",
        taskId: "task-1",
      },
    });

    expect(requests).toHaveLength(1);
    const { input, init } = requests[0]!;
    expect(input).toBe("https://internal/internal/runtime/events");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/json",
      [INTERNAL_RUNTIME_EVENT_TIMESTAMP_HEADER]: String(NOW),
    });
    const headers = init?.headers as Record<string, string>;
    expect(headers[INTERNAL_RUNTIME_EVENT_SIGNATURE_HEADER]).toMatch(/^v1=/);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      source: "secure-agent-api",
      eventType: "runtime.task.started",
    });
  });

  it("fails when Brain rejects the event", async () => {
    const client = new InternalRuntimeEventClient({
      brain: {
        async fetch() {
          return Response.json({ error: "bad" }, { status: 500 });
        },
      },
      secret: "runtime-event-secret",
      now: () => NOW,
    });

    await expect(
      client.publish({
        source: "secure-agent-api",
        eventType: "runtime.task.started",
        idempotencyKey: "run-1:session-1:task-1:runtime.task.started",
        payloadSchemaVersion: 1,
        payload: {},
      }),
    ).rejects.toThrow("Brain runtime event ingestion returned 500");
  });
});
