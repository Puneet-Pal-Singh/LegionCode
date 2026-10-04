import type {
  InternalRuntimeEventRequest,
  JsonValue,
  RunEvent,
} from "@repo/shared-types";
import { RUN_EVENT_TYPES, isRunEvent } from "@repo/shared-types";
import type {
  RunStepStatus,
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

function isTerminalStepStatus(status: RunStepStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}
