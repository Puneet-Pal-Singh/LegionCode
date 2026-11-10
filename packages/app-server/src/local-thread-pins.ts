import {
  EVENT_SCHEMA_VERSION,
  ThreadIdSchema,
  ThreadSchema,
  type EventCursor,
  type Thread,
  type ThreadId,
  type WorkspaceId,
} from "@repo/platform-protocol";
import type { LocalPersistence } from "@repo/event-store/local";
import { EventStoreError } from "@repo/event-store/errors";

export type LocalThreadPinServiceOptions = {
  readonly events: Pick<LocalPersistence["events"], "append" | "replay">;
  /** Required: the SAME per-thread queue used by every metadata writer, including rename/archive. */
  readonly serializeMetadataMutation: <T>(
    threadId: ThreadId,
    mutation: (scope: { readonly readThread: () => Promise<Thread> }) => Promise<T>,
  ) => Promise<T>;
};

/** Pin metadata only. The canonical Thread service owns authorization and mutation serialization. */
export class LocalThreadPinService {
  constructor(private readonly options: LocalThreadPinServiceOptions) {}

  pin(threadId: string): Promise<Thread> {
    return this.setPinned(ThreadIdSchema.parse(threadId), true);
  }

  unpin(threadId: string): Promise<Thread> {
    return this.setPinned(ThreadIdSchema.parse(threadId), false);
  }

  private setPinned(threadId: ThreadId, pinned: boolean): Promise<Thread> {
    // Delegate directly from LocalThreadService.pin/unpin: do not nest a second queue acquisition.
    return this.options.serializeMetadataMutation(threadId, async ({ readThread }) => {
      const authorized = ThreadSchema.parse(await readThread());
      if (authorized.id !== threadId) throw new EventStoreError("corrupt_event_stream", "Authorized Thread does not match the requested identity");
      if ((authorized.pinnedAt !== null) === pinned) return authorized;
      const nextSequence = await this.readThreadSequence(threadId, authorized.workspaceId) + 1;
      // Resolve again after replay so the full event payload uses the latest authorized metadata.
      const current = ThreadSchema.parse(await readThread());
      if (current.id !== threadId || authorized.id !== threadId || current.userId !== authorized.userId
        || current.workspaceId !== authorized.workspaceId) {
        throw new EventStoreError("corrupt_event_stream", "Authorized Thread identity changed during pin mutation");
      }
      if ((current.pinnedAt !== null) === pinned) return current;
      const timestamp = new Date().toISOString();
      const next = ThreadSchema.parse({
        ...current,
        pinnedAt: pinned ? timestamp : null,
        updatedAt: timestamp,
        lastEventSequence: nextSequence,
      });
      await this.options.events.append({
        threadId, workspaceId: current.workspaceId, runId: null,
        scopeType: "thread", scopeId: threadId,
        type: pinned ? "thread.pinned" : "thread.unpinned",
        payload: { thread: next },
        idempotencyKey: `thread-pin:${threadId}:${nextSequence}`,
        producer: { kind: "control_plane", id: "local-app-server" },
        schemaVersion: EVENT_SCHEMA_VERSION,
      });
      return ThreadSchema.parse(await readThread());
    });
  }

  private async readThreadSequence(threadId: ThreadId, workspaceId: WorkspaceId): Promise<number> {
    let afterCursor: EventCursor | null = null;
    let sequence = 0;
    const limit = 1_000;
    while (true) {
      const page = await this.options.events.replay({ scope: { scopeType: "thread", scopeId: threadId }, afterCursor, limit });
      for (const event of page.events) {
        if (event.threadId !== threadId || event.workspaceId !== workspaceId || event.scopeType !== "thread"
          || event.scopeId !== threadId || event.sequence !== sequence + 1
          || (sequence === 0 && event.type !== "thread.created")) {
          throw new EventStoreError("corrupt_event_stream", "Thread metadata replay has inconsistent identity or ordering");
        }
        sequence = event.sequence;
      }
      const last = page.events.at(-1);
      if (page.nextCursor !== (last?.cursor ?? null)) {
        throw new EventStoreError("corrupt_event_stream", "Thread metadata replay cursor is inconsistent");
      }
      if (page.events.length < limit) {
        if (sequence === 0) throw new EventStoreError("corrupt_event_stream", "Authorized Thread has no canonical creation event");
        return sequence;
      }
      afterCursor = page.nextCursor;
    }
  }
}
