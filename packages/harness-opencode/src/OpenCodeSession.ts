import { Schema } from "effect";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import { SessionInbox } from "@opencode/schema/session-inbox";
import { Location } from "@opencode/schema/location";
import type {
  OpenCodeEvent,
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
  private readonly permissions = new Map<
    string,
    { sessionID: string; committed: Promise<void> }
  >();
  private readonly forms = new Map<
    string,
    { sessionID: string; committed: Promise<void> }
  >();
  private readonly promptId = SessionMessage.ID.create();
  private promptSent = false;
  private stopping = false;
  private root: SessionInfo | undefined;

  private constructor(private readonly transport: OpenCodeClient) {}

  static async create(
    transport: OpenCodeClient,
    input: SessionCreateInput,
    commit: (event: OpenCodeEvent) => Promise<void>,
  ): Promise<OpenCodeSession> {
    if (
      !input.model?.id ||
      !input.model.providerID ||
      !input.location?.directory ||
      !input.permissions
    ) {
      throw new Error(
        "OpenCode requires an explicit model, workspace and permission policy.",
      );
    }
    const captured = structuredClone(input);
    const session = new OpenCodeSession(transport);
    await transport.subscribe(async (event) => {
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
      if (!sessionID || !session.sessions.has(sessionID)) return;
      // Install the generation-local capability before publishing, but gate its use on commit.
      const committed = Promise.resolve().then(() => commit(event));
      if (!session.stopping) {
        if (event.type === "permission.asked")
          session.permissions.set(event.data.id, { sessionID, committed });
        if (event.type === "form.created")
          session.forms.set(event.data.form.id, { sessionID, committed });
      }
      await committed;
      if (event.type === "permission.replied")
        session.permissions.delete(event.data.requestID);
      if (event.type === "form.replied" || event.type === "form.cancelled")
        session.forms.delete(event.data.id);
    });
    session.root = await transport.mutate("session.create", (api, signal) =>
      api.session.create(captured, { signal }),
    );
    if (!validSession(session.root))
      return transport.invalidate("session validation");
    session.sessions.add(session.root.id);
    return session;
  }

  get id(): string {
    if (!this.root) throw new Error("OpenCode session is not initialized.");
    return this.root.id;
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
    return this.permissions.get(requestID)?.sessionID;
  }

  async replyPermission(
    requestID: string,
    decision: "once" | "reject",
  ): Promise<void> {
    if (decision !== "once" && decision !== "reject")
      throw new Error("Unsupported OpenCode permission decision.");
    const pending = this.permissions.get(requestID);
    if (!pending || this.stopping)
      throw new OpenCodeTransportError("stale permission reply", true);
    this.permissions.delete(requestID);
    await pending.committed;
    const sessionID = pending.sessionID;
    await this.transport.mutate("permission.reply", (api, signal) =>
      api.permission.reply({ sessionID, requestID, decision }, { signal }),
    );
  }

  async replyForm(
    formID: string,
    answer: SessionFormReplyInput["answer"],
  ): Promise<void> {
    const pending = this.forms.get(formID);
    if (!pending || this.stopping)
      throw new OpenCodeTransportError("stale form reply", true);
    this.forms.delete(formID);
    await pending.committed;
    const sessionID = pending.sessionID;
    await this.transport.mutate("form.reply", (api, signal) =>
      api.session.form.reply({ sessionID, formID, answer }, { signal }),
    );
  }

  async cancelForm(formID: string): Promise<void> {
    const pending = this.forms.get(formID);
    if (!pending || this.stopping)
      throw new OpenCodeTransportError("stale form cancellation", true);
    this.forms.delete(formID);
    await pending.committed;
    const sessionID = pending.sessionID;
    await this.transport.mutate("form.cancel", (api, signal) =>
      api.session.form.cancel({ sessionID, formID }, { signal }),
    );
  }

  /**
   * Native interrupt acknowledgement only. This never releases a lease or reports quiescence.
   * After a gap/failure the host must terminate the isolated process boundary, not boot this store.
   */
  async interrupt(): Promise<
    ReadonlyArray<{ sessionID: string; interrupted: boolean }>
  > {
    this.stopping = true;
    this.permissions.clear();
    this.forms.clear();
    const parent = await this.transport.mutate(
      "session.interrupt",
      (api, signal) =>
        api.session.interrupt(
          { sessionID: this.id, resume: false },
          { signal },
        ),
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
        if (typeof item.id !== "string" || item.sessionID !== sessionID)
          return this.transport.invalidate("inbox scope validation");
        await this.transport.mutate("session.inbox.cancel", (api, signal) =>
          api.session.inbox.cancel({ sessionID, inboxID: item.id }, { signal }),
        );
      }
      if (sessionID === this.id) continue;
      const result = await this.transport.mutate(
        "session.interrupt",
        (api, signal) =>
          api.session.interrupt({ sessionID, resume: false }, { signal }),
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
    for (const sessionID of this.sessions) {
      const info = await this.transport.inspect("session.get", (api, signal) =>
        api.session.get({ sessionID }, { signal }),
      );
      if (!validSession(info) || info.id !== sessionID)
        return this.transport.invalidate("session validation");
      sessions.push(info);
    }
    const active = await this.transport.inspect(
      "session.active",
      (api, signal) => api.session.active({ signal }),
    );
    if (
      typeof active !== "object" ||
      active === null ||
      Object.values(active).some((value) => value?.type !== "running")
    ) {
      return this.transport.invalidate("active session validation");
    }
    return {
      sessions,
      activeSessionIds: Object.keys(active).filter((id) =>
        this.sessions.has(id),
      ),
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
