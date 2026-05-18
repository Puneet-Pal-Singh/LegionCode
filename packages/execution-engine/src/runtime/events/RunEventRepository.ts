import { RUN_EVENT_TYPES, type RunEvent } from "@repo/shared-types";
import type { RuntimeDurableObjectState } from "../types.js";

// RECONSTRUCTABILITY: Run events are an ephemeral DO cache. The canonical
// event history is in Postgres via PostgresRunRepository.appendEvent.
// Deleting this DO storage loses only in-flight runtime coordination state.
const RUN_EVENTS_KEY_PREFIX = "run_events:";

export class RunEventRepository {
  constructor(private readonly ctx: RuntimeDurableObjectState) {}

  async append(runId: string, event: RunEvent): Promise<void> {
    const key = this.getRunEventsKey(runId);
    await this.ctx.blockConcurrencyWhile(async () => {
      const events = (await this.ctx.storage.get<RunEvent[]>(key)) ?? [];
      await this.ctx.storage.put(key, [...events, event]);
    });
  }

  async appendApprovalResolvedIfMissing(
    runId: string,
    event: Extract<RunEvent, { type: typeof RUN_EVENT_TYPES.APPROVAL_RESOLVED }>,
  ): Promise<boolean> {
    const key = this.getRunEventsKey(runId);
    return await this.ctx.blockConcurrencyWhile(async () => {
      const events = (await this.ctx.storage.get<RunEvent[]>(key)) ?? [];
      const alreadyExists = events.some(
        (existingEvent) =>
          existingEvent.type === RUN_EVENT_TYPES.APPROVAL_RESOLVED &&
          existingEvent.payload.requestId === event.payload.requestId,
      );
      if (alreadyExists) {
        return false;
      }
      await this.ctx.storage.put(key, [...events, event]);
      return true;
    });
  }

  async getByRun(runId: string): Promise<RunEvent[]> {
    return (await this.ctx.storage.get<RunEvent[]>(this.getRunEventsKey(runId))) ?? [];
  }

  async clear(runId: string): Promise<void> {
    await this.ctx.storage.delete(this.getRunEventsKey(runId));
  }

  private getRunEventsKey(runId: string): string {
    return `${RUN_EVENTS_KEY_PREFIX}${runId}`;
  }
}
