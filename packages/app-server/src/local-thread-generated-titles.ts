import type { LocalPersistence } from "@repo/event-store/local";
import {
  EVENT_SCHEMA_VERSION,
  ThreadIdSchema,
  ThreadTitleUpdatedPayloadSchema,
  TurnAdmissionSchema,
  type LocalWorkspaceGrant,
  type PlatformEvent,
  type Thread,
  type ThreadId,
  type TurnAdmission,
} from "@repo/platform-protocol";
import { normalizeGeneratedTitle } from "./thread-titles/ThreadTitleOutput.js";
import type { ThreadTitleScope } from "./thread-titles/ThreadTitleTypes.js";

export interface LocalGeneratedTitleScope extends ThreadTitleScope {
  readonly grantedAt: LocalWorkspaceGrant["grantedAt"];
  readonly repositoryIdentity: LocalWorkspaceGrant["repositoryIdentity"];
}
export interface LocalGeneratedTitleClaim {
  readonly scope: Readonly<LocalGeneratedTitleScope>;
  readonly previewVersion: number;
  readonly prompt: string;
  readonly providerId: string;
  readonly modelId: string;
}
type FirstAdmissionReader = () => Promise<TurnAdmission | null>;
type MetadataScope = {
  readonly workspace: LocalWorkspaceGrant;
  readonly readThread: () => Promise<Thread>;
  readonly assertCurrent: () => Promise<void>;
};
type TitleEvent = Extract<PlatformEvent, { type: "thread.title.updated" }>;

/** Metadata adapter only: the existing Thread queue and event store own every write. */
export class LocalThreadGeneratedTitleMetadata {
  constructor(private readonly options: {
    events: Pick<LocalPersistence["events"], "listAll" | "append">;
    serializeMetadataMutation<T>(threadId: ThreadId, mutation: (scope: MetadataScope) => Promise<T>): Promise<T>;
  }) {}

  claim(admission: TurnAdmission, readFirst: FirstAdmissionReader): Promise<LocalGeneratedTitleClaim | null> {
    const captured = TurnAdmissionSchema.parse(admission);
    return this.options.serializeMetadataMutation(captured.turn.threadId, async (scope) => {
      const thread = await scope.readThread();
      if (thread.status !== "active" || thread.titleSource !== "preview" ||
          thread.titleStatus !== "ready" || thread.titleVersion !== 2) return null;
      const first = await this.readFirst(thread, readFirst);
      if (!first || first.turn.id !== captured.turn.id || first.run.id !== captured.run.id ||
          first.runAttemptId !== captured.runAttemptId || first.userMessage.id !== captured.userMessage.id ||
          first.run.providerId !== captured.run.providerId || first.run.modelId !== captured.run.modelId) return null;
      const previous = await this.readTitleEvent(thread);
      if (!this.matchesTitleEvent(previous, thread, first, "ready")) return null;
      const previewVersion = thread.titleVersion + 1;
      await this.append(scope, thread, first, {
        title: thread.title, source: "preview", status: "pending", version: previewVersion,
      });
      return Object.freeze({
        scope: Object.freeze({
          threadId: thread.id, runId: first.run.id, workspaceId: thread.workspaceId,
          userId: thread.userId, firstMessageId: first.userMessage.id,
          grantedAt: scope.workspace.grantedAt,
          repositoryIdentity: scope.workspace.repositoryIdentity,
        }),
        previewVersion,
        prompt: first.userMessage.type === "user_message" && typeof first.userMessage.content.text === "string"
          ? first.userMessage.content.text : "",
        providerId: first.run.providerId,
        modelId: first.run.modelId,
      });
    });
  }

  settle(
    claim: LocalGeneratedTitleClaim,
    outcome: { readonly status: "ready"; readonly title: string } | { readonly status: "failed" },
    readFirst: FirstAdmissionReader,
  ): Promise<Thread | null> {
    const expected = { ...claim.scope };
    const previewVersion = claim.previewVersion;
    const title = outcome.status === "ready" ? normalizeGeneratedTitle(outcome.title) : null;
    const status = outcome.status;
    if (status === "ready" && title === null) return Promise.resolve(null);
    const threadId = ThreadIdSchema.parse(expected.threadId);
    return this.options.serializeMetadataMutation(threadId, async (scope) => {
      if (scope.workspace.workspaceId !== expected.workspaceId ||
          scope.workspace.grantedAt !== expected.grantedAt ||
          scope.workspace.repositoryIdentity !== expected.repositoryIdentity) return null;
      const thread = await scope.readThread();
      if (thread.workspaceId !== expected.workspaceId || thread.userId !== expected.userId ||
          thread.status !== "active" || thread.titleSource !== "preview" ||
          thread.titleStatus !== "pending" || thread.titleVersion !== previewVersion) return null;
      const first = await this.readFirst(thread, readFirst);
      if (!first || first.run.id !== expected.runId || first.userMessage.id !== expected.firstMessageId) return null;
      const previous = await this.readTitleEvent(thread);
      if (!this.matchesTitleEvent(previous, thread, first, "pending")) return null;
      await this.append(scope, thread, first, {
        title: title ?? thread.title,
        source: status === "ready" ? "generated" : "preview",
        status,
        version: thread.titleVersion + 1,
      });
      return scope.readThread();
    });
  }

  private async readFirst(thread: Thread, readFirst: FirstAdmissionReader): Promise<TurnAdmission | null> {
    const result = await readFirst();
    if (!result) return null;
    const first = TurnAdmissionSchema.parse(result);
    return first.run.workspaceId === thread.workspaceId && first.run.userId === thread.userId &&
      first.run.threadId === thread.id && first.turn.threadId === thread.id &&
      first.turn.runId === first.run.id && first.userMessage.type === "user_message" ? first : null;
  }

  private async readTitleEvent(thread: Thread): Promise<TitleEvent | null> {
    const events = await this.options.events.listAll();
    return events.filter((event): event is TitleEvent => event.type === "thread.title.updated" &&
      event.threadId === thread.id && event.workspaceId === thread.workspaceId &&
      event.scopeType === "thread" && event.scopeId === thread.id).at(-1) ?? null;
  }

  private matchesTitleEvent(event: TitleEvent | null, thread: Thread, first: TurnAdmission, status: "ready" | "pending"): boolean {
    return Boolean(event && event.runId === first.run.id && event.payload.threadId === thread.id &&
      event.payload.firstMessageId === first.userMessage.id && event.payload.source === "preview" &&
      event.payload.titleVersion === thread.titleVersion && event.payload.title === thread.title &&
      event.payload.titleStatus === status);
  }

  private async append(scope: MetadataScope, thread: Thread, first: TurnAdmission, next: {
    title: string; source: "preview" | "generated"; status: "pending" | "ready" | "failed"; version: number;
  }): Promise<void> {
    const payload = ThreadTitleUpdatedPayloadSchema.parse({
      threadId: thread.id, firstMessageId: first.userMessage.id, title: next.title,
      titleVersion: next.version, source: next.source, titleStatus: next.status,
      timestamp: new Date().toISOString(),
    });
    await scope.assertCurrent();
    await this.options.events.append({
      threadId: thread.id, workspaceId: thread.workspaceId, runId: first.run.id,
      scopeType: "thread", scopeId: thread.id, type: "thread.title.updated", payload,
      idempotencyKey: `thread-title:${thread.id}:${first.userMessage.id}:${next.source}:${next.version}`,
      producer: { kind: "control_plane", id: "local-app-server" }, schemaVersion: EVENT_SCHEMA_VERSION,
    });
  }
}
