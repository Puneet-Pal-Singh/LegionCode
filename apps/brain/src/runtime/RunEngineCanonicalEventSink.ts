import type { JsonValue, RunEvent } from "@repo/shared-types";
import type { Env } from "../types/ai";
import { RuntimeEventProcessor } from "../services/runtime-events/RuntimeEventProcessor";

export class RunEngineCanonicalEventSink {
  private readonly processor: RuntimeEventProcessor;

  constructor(env: Env) {
    this.processor = new RuntimeEventProcessor(env);
  }

  async persist(event: RunEvent, correlationId: string): Promise<void> {
    const startedAt = Date.now();
    console.log(
      `[run/event-sink] correlationId=${correlationId} runId=${event.runId} sessionId=${event.sessionId ?? "missing"} eventId=${event.eventId} type=${event.type} status=started`,
    );

    await this.processor.process({
      source: "secure-agent-api",
      eventType: event.type,
      idempotencyKey: `${event.runId}:${event.eventId}`,
      payloadSchemaVersion: 1,
      payload: event as unknown as JsonValue,
    });

    console.log(
      `[run/event-sink] correlationId=${correlationId} runId=${event.runId} sessionId=${event.sessionId ?? "missing"} eventId=${event.eventId} type=${event.type} status=persisted elapsedMs=${Date.now() - startedAt}`,
    );
  }
}
