import { join } from "node:path";
import { z } from "zod";

import { FileEventStore } from "@repo/event-store";
import { projectThreadEvents } from "@repo/persistence";
import {
  EVENT_SCHEMA_VERSION,
  ThreadIdSchema,
  ThreadSchema,
  ThreadTitleUpdatedPayloadSchema,
  UserIdSchema,
  createThreadId,
  type LocalWorkspaceGrant,
  type PlatformEvent,
  type Thread,
  type ThreadId,
  type WorkspaceId,
} from "@repo/platform-protocol";

const LOCAL_USER_ID = UserIdSchema.parse("usr_localdesktop");
const ThreadCreateRequestSchema = z
  .object({ title: z.string().trim().min(1).max(80).optional() })
  .strict();
const ThreadRenameRequestSchema = z
  .object({ title: z.string().trim().min(1).max(80) })
  .strict();

export type LocalThreadServiceOptions = {
  storageDirectory: string;
  getWorkspace: () => Promise<LocalWorkspaceGrant | null>;
};

export class LocalThreadService {
  private readonly eventStore: FileEventStore;
  private readonly getWorkspace: LocalThreadServiceOptions["getWorkspace"];

  constructor(options: LocalThreadServiceOptions) {
    this.eventStore = new FileEventStore(join(options.storageDirectory, "thread-events.json"));
    this.getWorkspace = options.getWorkspace;
  }

  async list(): Promise<Thread[]> {
    const workspace = await this.requireWorkspace();
    const projections = await this.rebuildProjections();
    return projections
      .filter(({ workspaceId }) => workspaceId === workspace.workspaceId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async create(input: unknown): Promise<Thread> {
    const workspace = await this.requireWorkspace();
    const request = ThreadCreateRequestSchema.parse(input ?? {});
    const now = new Date().toISOString();
    const thread = ThreadSchema.parse({
      id: createThreadId(),
      userId: LOCAL_USER_ID,
      workspaceId: workspace.workspaceId,
      title: request.title ?? "New local thread",
      titleSource: "user",
      titleVersion: 1,
      titleStatus: "ready",
      lastTerminalTurnId: null,
      status: "active",
      pinnedAt: null,
      archivedAt: null,
      activeRunId: null,
      activeLeafItemId: null,
      createdAt: now,
      updatedAt: now,
      lastEventSequence: 1,
    });
    await this.eventStore.append({
      threadId: thread.id,
      workspaceId: thread.workspaceId,
      runId: null,
      scopeType: "thread",
      scopeId: thread.id,
      type: "thread.created",
      payload: { thread },
      idempotencyKey: `thread-created:${thread.id}`,
      producer: { kind: "control_plane", id: "local-app-server" },
      schemaVersion: EVENT_SCHEMA_VERSION,
    });
    return await this.projectThread(thread.id, workspace.workspaceId);
  }

  async get(threadId: string): Promise<Thread> {
    const workspace = await this.requireWorkspace();
    return await this.projectThread(ThreadIdSchema.parse(threadId), workspace.workspaceId);
  }

  async rename(threadId: string, input: unknown): Promise<Thread> {
    const workspace = await this.requireWorkspace();
    const thread = await this.projectThread(ThreadIdSchema.parse(threadId), workspace.workspaceId);
    const request = ThreadRenameRequestSchema.parse(input);
    if (thread.title === request.title) return thread;
    const titleVersion = thread.titleVersion + 1;
    const timestamp = new Date().toISOString();
    const payload = ThreadTitleUpdatedPayloadSchema.parse({
      threadId: thread.id,
      firstMessageId: null,
      title: request.title,
      titleVersion,
      source: "user",
      titleStatus: "ready",
      timestamp,
    });
    await this.eventStore.append({
      threadId: thread.id,
      workspaceId: thread.workspaceId,
      runId: null,
      scopeType: "thread",
      scopeId: thread.id,
      type: "thread.title.updated",
      payload,
      idempotencyKey: `thread-title:${thread.id}:${titleVersion}`,
      producer: { kind: "control_plane", id: "local-app-server" },
      schemaVersion: EVENT_SCHEMA_VERSION,
    });
    return await this.projectThread(thread.id, workspace.workspaceId);
  }

  async archive(threadId: string): Promise<Thread> {
    return await this.setArchived(threadId, true);
  }

  async unarchive(threadId: string): Promise<Thread> {
    return await this.setArchived(threadId, false);
  }

  private async setArchived(threadId: string, archived: boolean): Promise<Thread> {
    const workspace = await this.requireWorkspace();
    const thread = await this.projectThread(ThreadIdSchema.parse(threadId), workspace.workspaceId);
    if ((thread.status === "archived") === archived) return thread;
    const timestamp = new Date().toISOString();
    const next = ThreadSchema.parse({
      ...thread,
      status: archived ? "archived" : "active",
      archivedAt: archived ? timestamp : null,
      updatedAt: timestamp,
      lastEventSequence: thread.lastEventSequence + 1,
    });
    await this.eventStore.append({
      threadId: thread.id,
      workspaceId: thread.workspaceId,
      runId: null,
      scopeType: "thread",
      scopeId: thread.id,
      type: archived ? "thread.archived" : "thread.unarchived",
      payload: { thread: next },
      idempotencyKey: `thread-status:${thread.id}:${next.lastEventSequence}`,
      producer: { kind: "control_plane", id: "local-app-server" },
      schemaVersion: EVENT_SCHEMA_VERSION,
    });
    return await this.projectThread(thread.id, workspace.workspaceId);
  }

  private async projectThread(threadId: ThreadId, workspaceId: WorkspaceId): Promise<Thread> {
    const allEvents = await this.eventStore.listAll();
    const events = allEvents
      .filter((event) => event.threadId === threadId)
      .sort((left, right) => left.sequence - right.sequence)
      .map((event) => ({ event, projectionSequence: event.sequence }));
    const snapshot = projectThreadEvents(threadId, events);
    if (!snapshot || snapshot.thread.workspaceId !== workspaceId) {
      throw new LocalThreadNotFoundError();
    }
    return snapshot.thread;
  }

  private async rebuildProjections(): Promise<Thread[]> {
    const events = await this.eventStore.listAll();
    const projections = await this.collectProjections(events);
    return projections;
  }

  private async collectProjections(events: readonly PlatformEvent[]): Promise<Thread[]> {
    const threadIds = new Set<ThreadId>();
    for (const event of events) {
      if (event.type === "thread.created") threadIds.add(event.threadId);
    }
    const threads: Thread[] = [];
    for (const threadId of threadIds) {
      const threadEvents = events
        .filter((event) => event.threadId === threadId)
        .sort((left, right) => left.sequence - right.sequence)
        .map((event) => ({ event, projectionSequence: event.sequence }));
      const snapshot = projectThreadEvents(threadId, threadEvents);
      if (snapshot) threads.push(snapshot.thread);
    }
    return threads;
  }

  private async requireWorkspace(): Promise<LocalWorkspaceGrant> {
    const workspace = await this.getWorkspace();
    if (!workspace || workspace.readiness !== "ready") {
      throw new Error("A ready local workspace is required");
    }
    return workspace;
  }
}

export class LocalThreadNotFoundError extends Error {
  constructor() {
    super("Local thread was not found in the granted workspace");
    this.name = "LocalThreadNotFoundError";
  }
}
