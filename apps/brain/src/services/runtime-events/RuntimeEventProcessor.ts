import type {
  InternalRuntimeEventRequest,
  JsonValue,
  RunEvent,
} from "@repo/shared-types";
import { RUN_EVENT_TYPES, isRunEvent } from "@repo/shared-types";
import type {
  RunStatus,
  RunStepStatus,
  UpdateRunStatusInput,
  UpsertRunStepInput,
} from "@repo/persistence";
import type { Env } from "../../types/ai";
import { PersistenceService } from "../PersistenceService";

export interface RuntimeEventProcessorPort {
  process(event: InternalRuntimeEventRequest): Promise<void>;
}

export class RuntimeEventProcessor implements RuntimeEventProcessorPort {
  private persistenceService: PersistenceService;

  constructor(private env: Env) {
    this.persistenceService = new PersistenceService(env);
  }

  async process(event: InternalRuntimeEventRequest): Promise<void> {
    const { payload, eventType, idempotencyKey } = event;

    if (!isRunEvent(payload)) {
      if (isInternalRuntimeLifecycleEvent(eventType)) {
        return;
      }
      console.log(`[RuntimeEventProcessor] Unhandled event type: ${eventType}`);
      return;
    }

    await this.processRunEvent(payload, idempotencyKey);
  }

  private async processRunEvent(
    event: RunEvent,
    idempotencyKey: string,
  ): Promise<void> {
    assertSessionScopedRunEvent(event);
    await this.persistenceService.writeRunProjection({
      event: {
        runId: event.runId,
        sessionId: event.sessionId,
        eventType: event.type,
        payload: event as unknown as JsonValue,
        idempotencyKey,
      },
      step: buildRunStepCandidate(event),
      status: buildRunStatusUpdate(event),
    });
  }
}

function isInternalRuntimeLifecycleEvent(eventType: string): boolean {
  return (
    eventType === "runtime.task.started" ||
    eventType === "runtime.task.finished"
  );
}

function assertSessionScopedRunEvent(
  event: RunEvent,
): asserts event is RunEvent & { sessionId: string } {
  if (!event.sessionId) {
    throw new Error(`Missing sessionId for run event: ${event.runId}`);
  }
}

function buildRunStatusUpdate(
  event: RunEvent,
): UpdateRunStatusInput | undefined {
  const { runId, type, payload, timestamp } = event;

  switch (type) {
    case RUN_EVENT_TYPES.RUN_STARTED:
      return { id: runId, status: "running", startedAt: timestamp };
    case RUN_EVENT_TYPES.RUN_COMPLETED:
      return { id: runId, status: "completed", completedAt: timestamp };
    case RUN_EVENT_TYPES.RUN_FAILED:
      return { id: runId, status: "failed", completedAt: timestamp };
    case RUN_EVENT_TYPES.RUN_STATUS_CHANGED:
      return buildStatusChangedUpdate(runId, payload.newStatus, timestamp);
    default:
      return undefined;
  }
}

function buildStatusChangedUpdate(
  runId: string,
  status: string,
  timestamp: string,
): UpdateRunStatusInput | undefined {
  const mappedStatus = mapRunStatus(status);
  if (!mappedStatus) {
    return undefined;
  }

  return {
    id: runId,
    status: mappedStatus,
    startedAt: mappedStatus === "running" ? timestamp : undefined,
    completedAt: isTerminalRunStatus(mappedStatus) ? timestamp : undefined,
  };
}

function buildRunStep(
  event: RunEvent & { sessionId: string },
  sequence: number,
): UpsertRunStepInput | undefined {
  const status = mapRunStepStatus(event);
  if (!status) {
    return undefined;
  }

  return {
    runId: event.runId,
    stepIndex: sequence,
    stepType: event.type,
    status,
    startedAt: status === "running" ? event.timestamp : undefined,
    completedAt: isTerminalStepStatus(status) ? event.timestamp : undefined,
    payload: event.payload as unknown as JsonValue,
  };
}

function buildRunStepCandidate(
  event: RunEvent & { sessionId: string },
): UpsertRunStepInput | undefined {
  return buildRunStep(event, 0);
}

function mapRunStatus(status: string): RunStatus | null {
  switch (status) {
    case "queued":
    case "created":
      return "created";
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "complete":
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return null;
  }
}

function mapRunStepStatus(event: RunEvent): RunStepStatus | null {
  switch (event.type) {
    case RUN_EVENT_TYPES.RUN_PROGRESS:
      return event.payload.status === "completed" ? "completed" : "running";
    case RUN_EVENT_TYPES.APPROVAL_REQUESTED:
    case RUN_EVENT_TYPES.TOOL_REQUESTED:
      return "pending";
    case RUN_EVENT_TYPES.APPROVAL_RESOLVED:
    case RUN_EVENT_TYPES.TOOL_COMPLETED:
      return "completed";
    case RUN_EVENT_TYPES.TOOL_STARTED:
      return "running";
    case RUN_EVENT_TYPES.TOOL_FAILED:
      return "failed";
    default:
      return null;
  }
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return (
    status === "completed" ||
    status === "paused" ||
    status === "failed" ||
    status === "cancelled"
  );
}

function isTerminalStepStatus(status: RunStepStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}
