import type { JsonValue, RunEvent } from "@repo/shared-types";
import type { Env } from "../types/ai";
import { RuntimeEventProcessor } from "../services/runtime-events/RuntimeEventProcessor";

export class RunEngineCanonicalEventSink {
  private readonly processor: RuntimeEventProcessor;

  constructor(env: Env) {
    this.processor = new RuntimeEventProcessor(env);
  }

  async persist(event: RunEvent, correlationId: string): Promise<void> {
    try {
      await this.processor.process({
        source: "secure-agent-api",
        eventType: event.type,
        idempotencyKey: `${event.runId}:${event.eventId}`,
        payloadSchemaVersion: 1,
        payload: event as unknown as JsonValue,
      });
    } catch (error) {
      console.error("[run/event-sink] persist failed", {
        correlationId,
        runId: event.runId,
        sessionId: event.sessionId ?? "missing",
        eventId: event.eventId,
        eventType: event.type,
        error,
      });
      throw error;
    }
  }
}
