import type { JsonValue, RunEvent } from "@repo/shared-types";
import type { Env } from "../types/ai";
import { RuntimeEventProcessor } from "../services/runtime-events/RuntimeEventProcessor";
import { formatDiagnosticLogLine } from "../lib/diagnostic-log";

export class RunEngineCanonicalEventSink {
  private readonly processor: RuntimeEventProcessor;

  constructor(env: Env) {
    this.processor = new RuntimeEventProcessor(env);
  }

  async persist(event: RunEvent, correlationId: string): Promise<void> {
    const startedAt = Date.now();
    console.log(
      formatDiagnosticLogLine("run/event-sink", "persist-started", {
        correlationId,
        runId: event.runId,
        sessionId: event.sessionId ?? "missing",
        eventId: event.eventId,
        eventType: event.type,
      }),
    );

    await this.processor.process({
      source: "secure-agent-api",
      eventType: event.type,
      idempotencyKey: `${event.runId}:${event.eventId}`,
      payloadSchemaVersion: 1,
      payload: event as unknown as JsonValue,
    });

    console.log(
      formatDiagnosticLogLine("run/event-sink", "persisted", {
        correlationId,
        runId: event.runId,
        sessionId: event.sessionId ?? "missing",
        eventId: event.eventId,
        eventType: event.type,
        elapsedMs: Date.now() - startedAt,
      }),
    );
  }
}
