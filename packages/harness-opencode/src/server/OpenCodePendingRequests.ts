import { createHash } from "node:crypto";
import type {
  FormCreated,
  OpenCodeEvent,
  SessionFormReplyInput,
} from "@opencode/client";
import { OpenCodeClient, OpenCodeTransportError } from "./OpenCodeClient.js";

type Form = FormCreated["data"]["form"];
type Answer = SessionFormReplyInput["answer"];
type Pending = {
  readonly sessionID: string;
  readonly committed: Promise<void>;
  claimed: boolean;
};

type Dispatched = Readonly<
  { sessionID: string; requestID: string } & (
    | { kind: "permission"; decision: "once" | "reject" }
    | { kind: "form_reply"; answerFingerprint: string }
    | { kind: "form_cancel" }
  )
>;

/** Single-use native handles for this transport generation, gated by canonical commit. */
export class OpenCodePendingRequests {
  private readonly permissions = new Map<string, Pending>();
  private readonly forms = new Map<string, Pending & { form: Form }>();
  private readonly seen = new Set<string>();
  // Immutable effect receipts outlive claim handles, including Stop and HTTP ACK.
  // Only native confirmation deduplicates observation; it never sends an effect.
  private readonly dispatched = new Map<string, Dispatched>();
  private readonly confirmed = new Set<string>();
  private stopping = false;
  private released = false;

  constructor(private readonly transport: OpenCodeClient) {
    // Keep receipts throughout the live generation's observation drain. A lost
    // or closed transport cannot deliver more valid native confirmations.
    void transport.disconnected.then(() => {
      this.stopping = true;
      this.released = true;
      this.permissions.clear();
      this.forms.clear();
      this.dispatched.clear();
      this.confirmed.clear();
      this.seen.clear();
    });
  }

  get pending(): number {
    return this.permissions.size + this.forms.size;
  }

  async observe(
    event: OpenCodeEvent,
    commit: () => Promise<void>,
  ): Promise<void> {
    if (this.released)
      return this.transport.invalidate(
        "observation after request receipt release",
      );
    // Stop revokes claims, not already-dispatched evidence. Require the exact
    // native decision/answer in every state; cancellation is not a wildcard.
    let confirmation: string | undefined;
    if (event.type === "permission.replied") {
      confirmation = `permission:${event.data.requestID}`;
      const receipt = this.dispatched.get(confirmation);
      if (
        !receipt ||
        receipt.kind !== "permission" ||
        receipt.sessionID !== event.data.sessionID ||
        receipt.requestID !== event.data.requestID ||
        receipt.decision !== event.data.reply
      )
        return this.transport.invalidate(
          "permission settled outside canonical reply",
        );
    }
    if (event.type === "form.replied" || event.type === "form.cancelled") {
      confirmation = `form:${event.data.id}`;
      const receipt = this.dispatched.get(confirmation);
      const matches =
        receipt?.sessionID === event.data.sessionID &&
        receipt.requestID === event.data.id &&
        (event.type === "form.cancelled"
          ? receipt.kind === "form_cancel"
          : receipt.kind === "form_reply" &&
            receipt.answerFingerprint === answerFingerprint(event.data.answer));
      if (!matches)
        return this.transport.invalidate(
          "question settled outside canonical reply",
        );
    }
    if (confirmation && this.confirmed.has(confirmation)) return;
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
    if (confirmation && !this.released) this.confirmed.add(confirmation);
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
      this.remember(`permission:${requestID}`, {
        kind: "permission",
        sessionID: pending.sessionID,
        requestID,
        decision,
      });
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
      this.remember(`form:${formID}`, {
        kind: "form_reply",
        sessionID: pending.sessionID,
        requestID: formID,
        answerFingerprint: answerFingerprint(captured),
      });
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
      this.remember(`form:${formID}`, {
        kind: "form_cancel",
        sessionID: pending.sessionID,
        requestID: formID,
      });
      return api.session.form.cancel(
        { sessionID: pending.sessionID, formID },
        { signal },
      );
    });
  }

  fence(): void {
    // Drop all claim capabilities immediately. Dispatched receipts remain read-only
    // until transport retirement, so late confirmations can drain without a gap.
    this.stopping = true;
    this.permissions.clear();
    this.forms.clear();
  }

  private remember(id: string, receipt: Dispatched): void {
    if (
      !this.seen.has(id) ||
      this.dispatched.has(id) ||
      this.dispatched.size >= 1000
    )
      return this.transport.invalidate("dispatched receipt bound or duplicate");
    this.dispatched.set(id, Object.freeze(receipt));
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

function answerFingerprint(answer: Answer): string {
  // Preserve native array order; object field order has no answer meaning.
  return createHash("sha256")
    .update(
      JSON.stringify(
        Object.keys(answer)
          .sort()
          .map((key) => [key, answer[key]]),
      ),
    )
    .digest("hex");
}
