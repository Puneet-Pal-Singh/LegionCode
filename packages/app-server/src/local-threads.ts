import type { LocalPersistence } from "@repo/event-store/local";
import { buildThreadTitlePreview, projectThreadEvents } from "@repo/persistence";
import { LocalThreadPinService } from "./local-thread-pins.js";
import { LocalThreadGeneratedTitleMetadata } from "./local-thread-generated-titles.js";
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
  type TurnAdmission,
  type WorkspaceId,
} from "@repo/platform-protocol";

export const LOCAL_USER_ID = UserIdSchema.parse("usr_localdesktop");
export type LocalThreadServiceOptions = {
  events: LocalPersistence["events"];
  readRuntimeSummary?: LocalPersistence["turnAdmissions"]["readThreadSummary"];
  getWorkspace: () => Promise<LocalWorkspaceGrant | null>;
};

export class LocalThreadService {
  private readonly eventStore: LocalThreadServiceOptions["events"];
  private readonly getWorkspace: LocalThreadServiceOptions["getWorkspace"];
  private readonly readRuntimeSummary: LocalThreadServiceOptions["readRuntimeSummary"];
  private readonly metadataMutations = new Map<ThreadId, Promise<void>>();
  private readonly pins: LocalThreadPinService;
  readonly generatedTitles: LocalThreadGeneratedTitleMetadata;

  constructor(options: LocalThreadServiceOptions) {
    this.eventStore = options.events;
    this.getWorkspace = options.getWorkspace;
    this.readRuntimeSummary = options.readRuntimeSummary;
    this.pins = new LocalThreadPinService({
      events: this.eventStore,
      serializeMetadataMutation: (threadId, mutation) => this.serializeMetadataMutation(
        threadId,
        (workspace) => mutation({ readThread: () => this.readAuthorizedThread(threadId, workspace) }),
      ),
    });
    this.generatedTitles = new LocalThreadGeneratedTitleMetadata({
      events: this.eventStore,
      serializeMetadataMutation: (threadId, mutation) => this.serializeMetadataMutation(
        threadId,
        (workspace) => mutation({
          workspace,
          readThread: () => this.readAuthorizedThread(threadId, workspace),
          assertCurrent: () => this.assertWorkspaceCurrent(workspace),
        }),
      ),
      serializeRecoveryMutation: (threadId, workspaceId, mutation) => this.enqueueMetadataMutation(
        threadId, Promise.resolve(), () => mutation({
          readThread: async () => {
            const thread = await this.projectThread(threadId, workspaceId);
            if (thread.userId !== LOCAL_USER_ID) throw new LocalThreadNotFoundError();
            return thread;
          },
        }),
      ),
    });
  }

  /** Explicit startup metadata recovery; no filesystem grant or inference is acquired. */
  async recoverGeneratedTitleMetadata(readFirst: (threadId: ThreadId) => Promise<TurnAdmission | null>): Promise<void> {
    const threads = await this.listProjectMetadata();
    for (const thread of threads) {
      if (thread.titleSource === "preview" && thread.titleStatus === "pending")
        await this.generatedTitles.recover(thread, () => readFirst(thread.id));
    }
  }

  async list(): Promise<Thread[]> {
    const workspace = await this.requireWorkspace();
    const projections = await this.rebuildProjections(workspace.workspaceId);
    await this.assertWorkspaceCurrent(workspace);
    return projections
      .filter(({ workspaceId }) => workspaceId === workspace.workspaceId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  /** Navigation projection only. Does not authorize history, files, or mutations. */
  async listProjectMetadata(): Promise<Thread[]> {
    return (await this.rebuildProjections())
      .filter((thread) => thread.userId === LOCAL_USER_ID)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async create(input: unknown): Promise<Thread> {
    const workspace = await this.requireWorkspace();
    const request = ThreadCreateParamsSchema.parse(input ?? {});
    if (request.expectedWorkspace && (
      request.expectedWorkspace.workspaceId !== workspace.workspaceId ||
      request.expectedWorkspace.grantedAt !== workspace.grantedAt
    )) throw new Error("The local workspace grant changed before Thread creation");
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
    await this.assertWorkspaceCurrent(workspace);
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
    return await this.readAuthorizedThread(thread.id, workspace);
  }

  async get(threadId: string): Promise<Thread> {
    const workspace = await this.requireWorkspace();
    return await this.readAuthorizedThread(ThreadIdSchema.parse(threadId), workspace);
  }

  rename(threadId: string, input: unknown): Promise<Thread> {
    const id = ThreadIdSchema.parse(threadId);
    return this.serializeMetadataMutation(id, (workspace) => this.renameCurrent(id, input, workspace));
  }

  /** First-message metadata shares the exact queue used by explicit renames. */
  previewFirstAdmission(
    admission: TurnAdmission,
    readFirstAdmission: () => Promise<TurnAdmission | null>,
  ): Promise<Thread> {
    return this.serializeMetadataMutation(admission.turn.threadId, async (workspace) => {
      const thread = await this.readAuthorizedThread(admission.turn.threadId, workspace);
      if (admission.run.workspaceId !== thread.workspaceId || admission.run.userId !== thread.userId ||
          admission.run.threadId !== thread.id) throw new LocalThreadNotFoundError();
      if (thread.titleSource !== "none" || thread.titleVersion !== 1) return thread;
      const first = await readFirstAdmission();
      if (!first || first.run.workspaceId !== thread.workspaceId || first.run.userId !== thread.userId ||
          first.run.threadId !== thread.id || first.turn.threadId !== thread.id ||
          first.turn.runId !== first.run.id || first.userMessage.type !== "user_message") {
        throw new Error("Initial Thread title requires its first durable user admission");
      }
      const title = buildThreadTitlePreview(
        typeof first.userMessage.content.text === "string" ? first.userMessage.content.text : "",
      );
      const titleVersion = thread.titleVersion + 1;
      const payload = ThreadTitleUpdatedPayloadSchema.parse({
        threadId: thread.id,
        firstMessageId: first.userMessage.id,
        title,
        titleVersion,
        source: "preview",
        titleStatus: "ready",
        timestamp: new Date().toISOString(),
      });
      await this.assertWorkspaceCurrent(workspace);
      await this.eventStore.append({
        threadId: thread.id,
        workspaceId: thread.workspaceId,
        runId: first.run.id,
        scopeType: "thread",
        scopeId: thread.id,
        type: "thread.title.updated",
        payload,
        idempotencyKey: `thread-title:${thread.id}:${first.userMessage.id}:preview:${titleVersion}`,
        producer: { kind: "control_plane", id: "local-app-server" },
        schemaVersion: EVENT_SCHEMA_VERSION,
      });
      return this.readAuthorizedThread(thread.id, workspace);
    });
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
    if (thread.title === request.title && thread.titleSource === "user") return thread;
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
    // Capture at enqueue time: waiting actions must not adopt a replacement grant.
    return this.enqueueMetadataMutation(threadId, this.requireWorkspace(), async (workspace) => {
      await this.assertWorkspaceCurrent(workspace);
      return mutation(workspace);
    });
  }

  private enqueueMetadataMutation<T, TScope>(
    threadId: ThreadId,
    scope: Promise<TScope>,
    mutation: (scope: TScope) => Promise<T>,
  ): Promise<T> {
    const previous = this.metadataMutations.get(threadId) ?? Promise.resolve();
    const result = Promise.allSettled([previous, scope] as const).then(async ([, authorized]) => {
      if (authorized.status === "rejected") throw authorized.reason;
      return mutation(authorized.value);
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
    return this.withRuntimeSummary(snapshot.thread);
  }

  private async withRuntimeSummary(thread: Thread): Promise<Thread> {
    const summary = await this.readRuntimeSummary?.({
      threadId: thread.id, userId: thread.userId, workspaceId: thread.workspaceId,
    });
    if (!summary) return thread;
    return ThreadSchema.parse({
      ...thread,
      lastTerminalTurnId: summary.lastTerminalTurnId ?? thread.lastTerminalTurnId,
      ...(summary.latestAdmissionRunId === thread.activeRunId
        ? { activeLeafItemId: summary.activeLeafItemId } : {}),
      updatedAt: Date.parse(summary.updatedAt) > Date.parse(thread.updatedAt)
        ? summary.updatedAt : thread.updatedAt,
    });
  }

  private async rebuildProjections(workspaceId?: WorkspaceId): Promise<Thread[]> {
    const events = await this.eventStore.listAll();
    const projections = await this.collectProjections(events, workspaceId);
    return projections;
  }

  private async collectProjections(events: readonly PlatformEvent[], workspaceId?: WorkspaceId): Promise<Thread[]> {
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
      if (!snapshot || snapshot.thread.userId !== LOCAL_USER_ID ||
          (workspaceId !== undefined && snapshot.thread.workspaceId !== workspaceId)) continue;
      // Navigation grants metadata access only. Runtime history remains scoped
      // to the physically authorized workspace's existing list/get path.
      threads.push(workspaceId === undefined
        ? snapshot.thread
        : await this.withRuntimeSummary(snapshot.thread));
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
