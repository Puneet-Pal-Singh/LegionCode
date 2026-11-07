import { sameNativePermissions } from "./OpenCodePermissionPolicy.js";
import { OpenCodePendingRequests } from "./OpenCodePendingRequests.js";
import { OpenCodeWorkTracker } from "./OpenCodeWorkTracker.js";
import { Schema } from "effect";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import { SessionInbox } from "@opencode/schema/session-inbox";
import { Location } from "@opencode/schema/location";
import type {
  OpenCodeEvent,
  FormCreated,
  SessionCreateInput,
  SessionInfo,
  SessionFormReplyInput,
  SessionInboxUser,
  TokenUsageInfo,
} from "@opencode/client";
import { OpenCodeClient, OpenCodeTransportError } from "./OpenCodeClient.js";

/**
 * One native session subtree on one process generation. This is not a product Thread or Turn.
 * A lost transport cannot attach this object to another process. Resume is deliberately unavailable.
 */
export class OpenCodeSession {
  private readonly sessions = new Set<string>();
  private readonly work = new OpenCodeWorkTracker();
  private readonly requests: OpenCodePendingRequests;
  private readonly promptId = SessionMessage.ID.create();
  private promptSent = false;
  private stopping = false;
  private root: SessionInfo | undefined;

  private constructor(private readonly transport: OpenCodeClient) {
    this.requests = new OpenCodePendingRequests(transport);
  }

  static async create(
    transport: OpenCodeClient,
    input: SessionCreateInput,
    commit: (event: OpenCodeEvent) => Promise<void>,
  ): Promise<OpenCodeSession> {
    if (
      !input.model?.id ||
      !input.model.providerID ||
      !input.location?.directory ||
      !input.permissions?.length ||
      input.parentID !== undefined ||
      input.id !== undefined
    ) {
      throw new Error(
        "OpenCode requires an explicit model, workspace and permission policy.",
      );
    }
    const captured = structuredClone(input);
    const session = new OpenCodeSession(transport);
    // Know the native identity before dispatch: session.created can precede its HTTP receipt.
    const rootID = Session.ID.create();
    session.sessions.add(rootID);
    await transport.subscribe(async (event) => {
      session.work.observe(event);
      if (!session.promptSent && session.work.pending > 0)
        return transport.invalidate("background work before admitted prompt");
      if (
        event.type === "session.created" &&
        event.data.parentID &&
        session.sessions.has(event.data.parentID)
      ) {
        if (session.sessions.size >= 1000)
          return transport.invalidate("session hierarchy bound");
        session.sessions.add(event.data.sessionID);
      }
      const sessionID = sessionIdOf(event);
      if (!sessionID) return;
      if (!session.sessions.has(sessionID))
        return transport.invalidate("event outside owned session subtree");
      if (
        event.type === "session.created" &&
        (event.data.location.directory !== captured.location!.directory ||
          !sameNativePermissions(captured.permissions!, event.data.permissions))
      )
        return transport.invalidate("native child policy or workspace changed");
      if (!session.promptSent) {
        // Creation is metadata, not execution. Any other scoped activity before
        // admitted prompt dispatch is unsafe, even if session.create is in flight.
        if (
          event.type !== "session.created" ||
          sessionID !== rootID ||
          event.data.parentID !== undefined ||
          event.data.location.directory !== captured.location!.directory ||
          !sameNativePermissions(captured.permissions!, event.data.permissions)
        )
          return transport.invalidate("work before admitted prompt");
        return;
      }
      if (
        event.type === "session.inbox.enqueued" &&
        sessionID === rootID &&
        event.data.item.type === "user" &&
        event.data.inboxID !== session.promptId
      )
        return transport.invalidate("input outside admitted prompt binding");
      await session.requests.observe(event, () => commit(event));
    });
    session.root = await transport.mutate("session.create", (api, signal) =>
      api.session.create({ ...captured, id: rootID }, { signal }),
    );
    if (
      !validSession(session.root) ||
      session.root.id !== rootID ||
      session.root.parentID !== undefined ||
      session.root.location.directory !== captured.location!.directory ||
      !sameNativePermissions(captured.permissions!, session.root.permissions)
    )
      return transport.invalidate("session validation");
    return session;
  }

  get id(): string {
    if (!this.root) throw new Error("OpenCode session is not initialized.");
    return this.root.id;
  }

  /** Session overrides are necessary but not sufficient: the host separately attests agent/saved/hook policy. */
  async assertPermissions(
    expected: NonNullable<SessionCreateInput["permissions"]>,
  ): Promise<void> {
    const actual = await this.transport.inspect(
      "session policy",
      (api, signal) => api.session.get({ sessionID: this.id }, { signal }),
    );
    if (
      !validSession(actual) ||
      actual.id !== this.id ||
      actual.parentID !== undefined ||
      actual.location.directory !== this.root?.location.directory ||
      !sameNativePermissions(expected, actual.permissions)
    ) {
      return this.transport.invalidate("native session policy changed");
    }
  }

  get pendingNativeWork(): number {
    return this.work.pending + this.requests.pending;
  }

  get externalTurnId(): string {
    return this.promptId;
  }

  /** Caller must hold canonical admission, checkout lease and persisted start evidence first. */
  async prompt(text: string): Promise<SessionInboxUser> {
    if (this.promptSent || this.stopping)
      throw new OpenCodeTransportError("prompt already attempted", true);
    // Consume before dispatch, including network errors. An ambiguous prompt is never resent.
    this.promptSent = true;
    const result = await this.transport.mutate(
      "session.prompt",
      (api, signal) =>
        api.session.prompt(
          { sessionID: this.id, id: this.promptId, text },
          { signal },
        ),
    );
    if (
      !validInboxUser(result) ||
      result.sessionID !== this.id ||
      result.id !== this.promptId
    )
      return this.transport.invalidate("prompt receipt validation");
    return result;
  }

  permissionOrigin(requestID: string): string | undefined {
    return this.requests.permissionOrigin(requestID);
  }

  replyPermission(
    requestID: string,
    decision: "once" | "reject",
  ): Promise<void> {
    return this.requests.replyPermission(requestID, decision);
  }

  pendingForm(formID: string): FormCreated["data"]["form"] | undefined {
    return this.requests.pendingForm(formID);
  }

  replyForm(
    formID: string,
    answer: SessionFormReplyInput["answer"],
  ): Promise<void> {
    return this.requests.replyForm(formID, answer);
  }

  cancelForm(formID: string): Promise<void> {
    return this.requests.cancelForm(formID);
  }

  fence(): void {
    this.stopping = true;
    this.requests.fence();
  }

  /**
   * Native interrupt acknowledgement only. This never releases a lease or reports quiescence.
   * After a gap/failure the host must terminate the isolated process boundary, not boot this store.
   */
  async interrupt(): Promise<
    ReadonlyArray<{ sessionID: string; interrupted: boolean }>
  > {
    this.fence();
    const parent = await this.transport.mutate(
      "session.interrupt",
      (api, signal) => {
        this.requests.interruptDispatched(this.id);
        return api.session.interrupt(
          { sessionID: this.id, resume: false },
          { signal },
        );
      },
    );
    if (typeof parent.interrupted !== "boolean")
      return this.transport.invalidate("interrupt receipt validation");
    await this.discoverDescendants();
    const results: Array<{ sessionID: string; interrupted: boolean }> = [
      { sessionID: this.id, interrupted: parent.interrupted },
    ];
    // Parent first fences new foreground work. Interrupt every discovered descendant as well.
    for (const sessionID of this.sessions) {
      const inbox = await this.transport.inspect(
        "session.inbox.list",
        (api, signal) => api.session.inbox.list({ sessionID }, { signal }),
      );
      if (!Array.isArray(inbox) || inbox.length > 1000)
        return this.transport.invalidate("inbox validation");
      for (const item of inbox) {
        if (!validInbox(item) || item.sessionID !== sessionID)
          return this.transport.invalidate("inbox scope validation");
        await this.transport.mutate("session.inbox.cancel", (api, signal) =>
          api.session.inbox.cancel({ sessionID, inboxID: item.id }, { signal }),
        );
      }
      if (sessionID === this.id) continue;
      const result = await this.transport.mutate(
        "session.interrupt",
        (api, signal) => {
          this.requests.interruptDispatched(sessionID);
          return api.session.interrupt(
            { sessionID, resume: false },
            { signal },
          );
        },
      );
      if (typeof result.interrupted !== "boolean")
        return this.transport.invalidate("interrupt receipt validation");
      results.push({ sessionID, interrupted: result.interrupted });
    }
    return results;
  }

  /** Explicit recovery evidence. It must not be appended as a replacement product transcript. */
  async reconcile(): Promise<{
    readonly sessions: ReadonlyArray<SessionInfo>;
    readonly activeSessionIds: ReadonlyArray<string>;
    readonly continuity: OpenCodeClient["continuity"];
  }> {
    await this.discoverDescendants();
    const sessions: SessionInfo[] = [];
    const queuedSessionIds = new Set<string>();
    for (const sessionID of this.sessions) {
      const info = await this.transport.inspect("session.get", (api, signal) =>
        api.session.get({ sessionID }, { signal }),
      );
      if (!validSession(info) || info.id !== sessionID)
        return this.transport.invalidate("session validation");
      sessions.push(info);
      const inbox = await this.transport.inspect(
        "session.inbox.list",
        (api, signal) => api.session.inbox.list({ sessionID }, { signal }),
      );
      if (
        !Array.isArray(inbox) ||
        inbox.length > 1000 ||
        inbox.some((item) => !validInbox(item) || item.sessionID !== sessionID)
      )
        return this.transport.invalidate("inbox scope validation");
      if (inbox.length) queuedSessionIds.add(sessionID);
    }
    const active = await this.transport.inspect(
      "session.active",
      (api, signal) => api.session.active({ signal }),
    );
    if (
      typeof active !== "object" ||
      active === null ||
      Array.isArray(active) ||
      Object.keys(active).some((id) => !this.sessions.has(id)) ||
      Object.values(active).some((value) => value?.type !== "running")
    ) {
      return this.transport.invalidate("active session validation");
    }
    return {
      sessions,
      // A queued prompt can start after the instantaneous active read. It still
      // owns this attempt even while its session reports idle.
      activeSessionIds: [
        ...new Set([...Object.keys(active), ...queuedSessionIds]),
      ],
      continuity: this.transport.continuity,
    };
  }

  /** Session tokens and harness cost (possibly estimated); neither is account quota or a billed charge. */
  async usage(): Promise<{ tokens: TokenUsageInfo; cost: number }> {
    const info = await this.transport.inspect("session.get", (api, signal) =>
      api.session.get({ sessionID: this.id }, { signal }),
    );
    if (!validSession(info) || info.id !== this.id)
      return this.transport.invalidate("session validation");
    return { tokens: info.tokens, cost: info.cost };
  }

  private async discoverDescendants(): Promise<void> {
    // Set iteration visits new descendants; both hierarchy and pagination are bounded.
    for (const parentID of this.sessions) {
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await this.transport.inspect(
          "session.list",
          (api, signal) =>
            api.session.list(
              {
                parentID,
                limit: 100,
                ...(cursor ? { cursor } : { order: "asc" }),
              },
              { signal },
            ),
        );
        if (
          !Array.isArray(page?.data) ||
          page.data.length > 100 ||
          typeof page.cursor !== "object" ||
          page.cursor === null ||
          (page.cursor.next != null && typeof page.cursor.next !== "string")
        )
          return this.transport.invalidate("session page validation");
        for (const child of page.data) {
          if (!validSession(child) || child.parentID !== parentID)
            return this.transport.invalidate("session hierarchy");
          this.sessions.add(child.id);
        }
        cursor = page.cursor.next ?? undefined;
        if (cursor && seen.has(cursor))
          return this.transport.invalidate("session pagination");
        if (cursor) seen.add(cursor);
        if (seen.size > 100 || this.sessions.size > 1000)
          return this.transport.invalidate("session hierarchy bound");
      } while (cursor);
    }
  }
}

function sessionIdOf(event: OpenCodeEvent): string | undefined {
  if (event.type === "form.created") return event.data.form.sessionID;
  if (
    "data" in event &&
    "sessionID" in event.data &&
    typeof event.data.sessionID === "string"
  )
    return event.data.sessionID;
  return undefined;
}

// Public wire shape from the pinned protocol's makeSessionGroup, using its authoritative schemas.
const validSession = Schema.is(
  Schema.toEncoded(
    Schema.Struct({ ...Session.Info.fields, location: Location.PublicRef }),
  ),
);
const validInboxUser = Schema.is(Schema.toEncoded(SessionInbox.User));
const validInbox = Schema.is(Schema.toEncoded(SessionInbox.Info));
