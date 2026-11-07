import type { LocalPersistence } from "@repo/event-store/local";
import { projectThreadEvents } from "@repo/persistence";
import { LocalThreadPinService } from "./local-thread-pins.js";
import { ThreadCreateParamsSchema, ThreadRenameParamsSchema } from "./protocol.js";
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
export type LocalThreadServiceOptions = {
  events: LocalPersistence["events"];
  getWorkspace: () => Promise<LocalWorkspaceGrant | null>;
};

export class LocalThreadService {
  private readonly eventStore: LocalThreadServiceOptions["events"];
  private readonly getWorkspace: LocalThreadServiceOptions["getWorkspace"];
  private readonly metadataMutations = new Map<ThreadId, Promise<void>>();
  private readonly pins: LocalThreadPinService;

  constructor(options: LocalThreadServiceOptions) {
    this.eventStore = options.events;
    this.getWorkspace = options.getWorkspace;
    this.pins = new LocalThreadPinService({
      events: this.eventStore,
      serializeMetadataMutation: (threadId, mutation) => this.serializeMetadataMutation(
        threadId,
        (workspace) => mutation({ readThread: () => this.readAuthorizedThread(threadId, workspace) }),
      ),
    });
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
    const request = ThreadCreateParamsSchema.parse(input ?? {});
    const now = new Date().toISOString();
    const thread = ThreadSchema.parse({
      id: createThreadId(),
      userId: LOCAL_USER_ID,
      workspaceId: workspace.workspaceId,
      title: request.title ?? "New local thread",
      titleSource: request.title ? "user" : "none",
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

  rename(threadId: string, input: unknown): Promise<Thread> {
    const id = ThreadIdSchema.parse(threadId);
    return this.serializeMetadataMutation(id, (workspace) => this.renameCurrent(id, input, workspace));
  }

  pin(threadId: string): Promise<Thread> {
    return this.pins.pin(threadId);
  }

  unpin(threadId: string): Promise<Thread> {
    return this.pins.unpin(threadId);
  }

  private async renameCurrent(threadId: ThreadId, input: unknown, workspace: LocalWorkspaceGrant): Promise<Thread> {
    const thread = await this.readAuthorizedThread(threadId, workspace);
    const request = ThreadRenameParamsSchema.parse({
      ...(input && typeof input === "object" ? input : {}),
      threadId,
    });
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
    return await this.readAuthorizedThread(thread.id, workspace);
  }

  async archive(threadId: string): Promise<Thread> {
    return await this.setArchived(threadId, true);
  }

  async unarchive(threadId: string): Promise<Thread> {
    return await this.setArchived(threadId, false);
  }

  private setArchived(threadId: string, archived: boolean): Promise<Thread> {
    const id = ThreadIdSchema.parse(threadId);
    return this.serializeMetadataMutation(id, (workspace) => this.setArchivedCurrent(id, archived, workspace));
  }

  private async setArchivedCurrent(threadId: ThreadId, archived: boolean, workspace: LocalWorkspaceGrant): Promise<Thread> {
    const thread = await this.readAuthorizedThread(threadId, workspace);
    if ((thread.status === "archived") === archived) return thread;
    const timestamp = new Date().toISOString();
    const metadataEvents = await this.eventStore.listAll();
    const nextMetadataSequence = metadataEvents.reduce((last, event) =>
      event.scopeType === "thread" && event.scopeId === thread.id
        ? Math.max(last, event.sequence) : last, 0) + 1;
    const next = ThreadSchema.parse({
      ...thread,
      status: archived ? "archived" : "active",
      archivedAt: archived ? timestamp : null,
      updatedAt: timestamp,
      lastEventSequence: nextMetadataSequence,
    });
    await this.assertWorkspaceCurrent(workspace);
    await this.eventStore.append({
      threadId: thread.id,
      workspaceId: thread.workspaceId,
      runId: null,
      scopeType: "thread",
      scopeId: thread.id,
      type: archived ? "thread.archived" : "thread.unarchived",
      payload: { thread: next },
      idempotencyKey: `thread-status:${thread.id}:${nextMetadataSequence}`,
      producer: { kind: "control_plane", id: "local-app-server" },
      schemaVersion: EVENT_SCHEMA_VERSION,
    });
    return await this.readAuthorizedThread(thread.id, workspace);
  }

  /** Every existing-Thread metadata writer acquires this one service-owned queue. */
  private serializeMetadataMutation<T>(
    threadId: ThreadId,
    mutation: (workspace: LocalWorkspaceGrant) => Promise<T>,
  ): Promise<T> {
    const previous = this.metadataMutations.get(threadId) ?? Promise.resolve();
    // Capture at enqueue time: waiting actions must not adopt a replacement grant.
    const result = Promise.allSettled([previous, this.requireWorkspace()] as const).then(async ([, grant]) => {
      if (grant.status === "rejected") throw grant.reason;
      const workspace = grant.value;
      await this.assertWorkspaceCurrent(workspace);
      return mutation(workspace);
    });
    // A failed action must not poison the next action or leave a rejected cleanup promise.
    const settled = result.then(() => undefined, () => undefined);
    this.metadataMutations.set(threadId, settled);
    void settled.then(() => {
      if (this.metadataMutations.get(threadId) === settled) this.metadataMutations.delete(threadId);
    });
    return result;
  }

  private async readAuthorizedThread(threadId: ThreadId, workspace: LocalWorkspaceGrant): Promise<Thread> {
    const thread = await this.projectThread(threadId, workspace.workspaceId);
    await this.assertWorkspaceCurrent(workspace);
    if (thread.userId !== LOCAL_USER_ID) throw new LocalThreadNotFoundError();
    return thread;
  }

  private async assertWorkspaceCurrent(expected: LocalWorkspaceGrant): Promise<void> {
    const current = await this.requireWorkspace();
    if (current.workspaceId !== expected.workspaceId || current.grantedAt !== expected.grantedAt
      || current.repositoryIdentity !== expected.repositoryIdentity) {
      throw new Error("Local workspace grant changed during Thread metadata mutation");
    }
  }

  private async projectThread(threadId: ThreadId, workspaceId: WorkspaceId): Promise<Thread> {
    const allEvents = await this.eventStore.listAll();
    const events = allEvents
      .filter((event) => event.threadId === threadId)
      .map((event, index) => ({ event, projectionSequence: index + 1 }));
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
    const grouped = new Map<ThreadId, { event: PlatformEvent; projectionSequence: number }[]>();
    for (const event of events) {
      if (event.type === "thread.created") threadIds.add(event.threadId);
      let inputs = grouped.get(event.threadId);
      if (!inputs) { inputs = []; grouped.set(event.threadId, inputs); }
      inputs.push({ event, projectionSequence: inputs.length + 1 });
    }
    const threads: Thread[] = [];
    for (const threadId of threadIds) {
      const snapshot = projectThreadEvents(threadId, grouped.get(threadId) ?? []);
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
