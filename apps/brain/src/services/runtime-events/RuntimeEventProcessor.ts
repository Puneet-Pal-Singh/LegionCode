import type { InternalRuntimeEventRequest, RunEvent, JsonValue, RunEventType } from "@repo/shared-types";
import { RUN_EVENT_TYPES, isRunEvent } from "@repo/shared-types";
import { PersistenceService } from "../PersistenceService";
import type { Env } from "../../types/ai";
import type { RunStatus } from "@repo/persistence";

export class RuntimeEventProcessor {
  private persistenceService: PersistenceService;

  constructor(private env: Env) {
    this.persistenceService = new PersistenceService(env);
  }

  async process(event: InternalRuntimeEventRequest): Promise<void> {
    const { payload, eventType, idempotencyKey } = event;

    if (isRunEvent(payload)) {
      await this.processRunEvent(payload, idempotencyKey);
    } else {
      console.log(`[RuntimeEventProcessor] Unhandled event type: ${eventType}`);
    }
  }

  private async processRunEvent(
    event: RunEvent,
    idempotencyKey: string,
  ): Promise<void> {
    this.validateRunEvent(event);
    await this.persistRunEvent(event, idempotencyKey);
    await this.handleStatusTransition(event);
  }

  private validateRunEvent(event: RunEvent): void {
    if (!event.sessionId) {
      throw new Error(`Missing sessionId for run event: ${event.runId}`);
    }
  }

  private async persistRunEvent(
    event: RunEvent,
    idempotencyKey: string,
  ): Promise<void> {
    await this.persistenceService.appendRunEvent({
      runId: event.runId,
      sessionId: event.sessionId as string,
      eventType: event.type,
      payload: event.payload as unknown as JsonValue,
      idempotencyKey,
    });
  }

  private async handleStatusTransition(event: RunEvent): Promise<void> {
    const { runId, type, payload, timestamp } = event;

    switch (type) {
      case RUN_EVENT_TYPES.RUN_STARTED:
        await this.persistenceService.updateRunStatus(
          runId,
          "running",
          timestamp,
        );
        break;

      case RUN_EVENT_TYPES.RUN_COMPLETED:
        await this.persistenceService.updateRunStatus(
          runId,
          "completed",
          undefined,
          timestamp,
        );
        break;

      case RUN_EVENT_TYPES.RUN_FAILED:
        await this.persistenceService.updateRunStatus(
          runId,
          "failed",
          undefined,
          timestamp,
        );
        break;

      case RUN_EVENT_TYPES.RUN_STATUS_CHANGED: {
        const statusPayload = payload as { newStatus: string };
        const newStatus = mapRunStatus(statusPayload.newStatus);
        if (newStatus) {
          await this.persistenceService.updateRunStatus(runId, newStatus);
        }
        break;
      }

      default:
        break;
    }
  }
}

function mapRunStatus(status: string): RunStatus | null {
  switch (status) {
    case "queued":
    case "created":
      return "created";
    case "running":
      return "running";
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
