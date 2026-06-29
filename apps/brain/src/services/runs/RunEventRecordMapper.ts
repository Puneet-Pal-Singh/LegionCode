import { safeParseRunEvent, type RunEvent } from "@repo/shared-types";
import type { RunEventRecord } from "@repo/persistence";

export function mapRunEventRecordsToCanonicalEvents(
  records: readonly RunEventRecord[],
): RunEvent[] {
  return records.map(mapRunEventRecordToCanonicalEvent);
}

export function mapRunEventRecordToCanonicalEvent(
  record: RunEventRecord,
): RunEvent {
  const parsed = safeParseRunEvent(record.payload);
  if (!parsed.success) {
    throw new Error(
      `Persisted run event is not a canonical RunEvent envelope: runId=${record.runId} eventId=${record.id} eventType=${record.eventType} error=${parsed.error}`,
    );
  }

  const event = parsed.data;
  assertRecordMatchesEvent(record, event);
  return event;
}

function assertRecordMatchesEvent(
  record: RunEventRecord,
  event: RunEvent,
): void {
  if (
    record.runId !== event.runId ||
    record.sessionId !== event.sessionId ||
    record.eventType !== event.type
  ) {
    throw new Error(
      `Persisted run event envelope does not match indexed record: recordRunId=${record.runId} eventRunId=${event.runId} recordSessionId=${record.sessionId} eventSessionId=${event.sessionId ?? "missing"} recordEventType=${record.eventType} eventType=${event.type}`,
    );
  }
}
