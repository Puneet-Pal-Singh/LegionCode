import type {
  FormCreated,
  OpenCodeEvent,
  SessionFormReplyInput,
} from "@opencode/client";
import { OpenCodeClient, OpenCodeTransportError } from "./OpenCodeClient.js";

type Form = FormCreated["data"]["form"];
type Answer = SessionFormReplyInput["answer"];
type Pending = {
  sessionID: string;
  committed: Promise<void>;
  claimed: boolean;
};

/** Single-use native handles for this transport generation, gated by canonical commit. */
export class OpenCodePendingRequests {
  private readonly permissions = new Map<
    string,
    Pending & { decision?: "once" | "reject" }
  >();
  private readonly forms = new Map<
    string,
    Pending & {
      form: Form;
      sent?: { kind: "reply"; answer: Answer } | { kind: "cancel" };
    }
  >();
  private readonly seen = new Set<string>();
  private stopping = false;

  constructor(private readonly transport: OpenCodeClient) {}

  get pending(): number {
    return this.permissions.size + this.forms.size;
  }

  async observe(
    event: OpenCodeEvent,
    commit: () => Promise<void>,
  ): Promise<void> {
    // A native settlement can arrive before the HTTP reply receipt. Require the
    // exact dispatched decision, not merely absence from a pending-request map.
    if (event.type === "permission.replied") {
      const pending = this.permissions.get(event.data.requestID);
      if (
        this.stopping
          ? event.data.reply !== "reject"
          : !pending ||
            pending.sessionID !== event.data.sessionID ||
            pending.decision !== event.data.reply
      ) {
        return this.transport.invalidate(
          "permission settled outside canonical reply",
        );
      }
    }
    if (event.type === "form.replied" || event.type === "form.cancelled") {
      const pending = this.forms.get(event.data.id);
      const matches =
        pending?.sessionID === event.data.sessionID &&
        (event.type === "form.cancelled"
          ? pending.sent?.kind === "cancel"
          : pending.sent?.kind === "reply" &&
            sameAnswer(pending.sent.answer, event.data.answer));
      if (this.stopping ? event.type !== "form.cancelled" : !matches)
        return this.transport.invalidate(
          "question settled outside canonical reply",
        );
    }
    if (!this.stopping && event.type === "permission.asked")
      this.reserve(`permission:${event.data.id}`);
    if (!this.stopping && event.type === "form.created")
      this.reserve(`form:${event.data.form.id}`);
    const committed = Promise.resolve().then(commit);
    if (!this.stopping) {
      if (event.type === "permission.asked") {
        this.permissions.set(event.data.id, {
          sessionID: event.data.sessionID,
          committed,
          claimed: false,
        });
      }
      if (event.type === "form.created") {
        this.forms.set(event.data.form.id, {
          sessionID: event.data.form.sessionID,
          committed,
          claimed: false,
          form: structuredClone(event.data.form),
        });
      }
    }
    await committed;
    if (event.type === "permission.replied")
      this.permissions.delete(event.data.requestID);
    if (event.type === "form.replied" || event.type === "form.cancelled")
      this.forms.delete(event.data.id);
  }

  permissionOrigin(requestID: string): string | undefined {
    const pending = this.permissions.get(requestID);
    return pending?.claimed ? undefined : pending?.sessionID;
  }

  async replyPermission(
    requestID: string,
    decision: "once" | "reject",
  ): Promise<void> {
    if (decision !== "once" && decision !== "reject")
      throw new OpenCodeTransportError(
        "unsupported permission decision",
        false,
      );
    const pending = await this.claim(this.permissions.get(requestID));
    await this.transport.mutate("permission.reply", (api, signal) => {
      this.assertNotStopping();
      pending.decision = decision;
      return api.permission.reply(
        { sessionID: pending.sessionID, requestID, decision },
        { signal },
      );
    });
  }

  pendingForm(formID: string): Form | undefined {
    const pending = this.forms.get(formID);
    return pending && !pending.claimed
      ? structuredClone(pending.form)
      : undefined;
  }

  async replyForm(formID: string, answer: Answer): Promise<void> {
    const captured = structuredClone(answer);
    const pending = await this.claim(this.forms.get(formID));
    await this.transport.mutate("form.reply", (api, signal) => {
      this.assertNotStopping();
      pending.sent = { kind: "reply", answer: captured };
      return api.session.form.reply(
        { sessionID: pending.sessionID, formID, answer: captured },
        { signal },
      );
    });
  }

  async cancelForm(formID: string): Promise<void> {
    const pending = await this.claim(this.forms.get(formID));
    await this.transport.mutate("form.cancel", (api, signal) => {
      this.assertNotStopping();
      pending.sent = { kind: "cancel" };
      return api.session.form.cancel(
        { sessionID: pending.sessionID, formID },
        { signal },
      );
    });
  }

  fence(): void {
    this.stopping = true;
    this.permissions.clear();
    this.forms.clear();
  }

  private async claim<T extends Pending>(pending: T | undefined): Promise<T> {
    if (!pending || pending.claimed || this.stopping)
      throw new OpenCodeTransportError("stale native reply", true);
    pending.claimed = true;
    await pending.committed;
    this.assertNotStopping();
    return pending;
  }

  private assertNotStopping(): void {
    if (this.stopping)
      throw new OpenCodeTransportError("reply fenced by Stop", true);
  }

  private reserve(id: string): void {
    if (this.pending >= 128 || this.seen.size >= 1000 || this.seen.has(id))
      return this.transport.invalidate("pending request bound or duplicate");
    this.seen.add(id);
  }
}

function sameAnswer(expected: Answer, actual: Answer): boolean {
  const keys = Object.keys(expected).sort();
  return (
    JSON.stringify(keys) === JSON.stringify(Object.keys(actual).sort()) &&
    keys.every(
      (key) => JSON.stringify(expected[key]) === JSON.stringify(actual[key]),
    )
  );
}
