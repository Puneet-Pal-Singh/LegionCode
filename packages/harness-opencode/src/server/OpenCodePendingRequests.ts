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

type KnownForm = Readonly<{
  sessionID: string;
  requestID: string;
  /** This object is never rebound to a replacement native process. */
  generation: OpenCodeClient;
}>;

/** Single-use native handles for this transport generation, gated by canonical commit. */
export class OpenCodePendingRequests {
  private readonly permissions = new Map<string, Pending>();
  private readonly forms = new Map<string, Pending & { form: Form }>();
  private readonly seen = new Set<string>();
  // Immutable effect receipts outlive claim handles, including Stop and HTTP ACK.
  // Only native confirmation deduplicates observation; it never sends an effect.
  private readonly dispatched = new Map<string, Dispatched>();
  private readonly confirmed = new Set<string>();
  private readonly knownForms = new Map<string, KnownForm>();
  private readonly stopFormClosures = new Map<string, KnownForm>();
  private readonly formSettlements = new Map<string, string>();
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
      this.knownForms.clear();
      this.stopFormClosures.clear();
      this.formSettlements.clear();
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
    let formSettlement: string | undefined;
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
      const closure = this.stopFormClosures.get(event.data.id);
      const answer =
        event.type === "form.replied"
          ? answerFingerprint(event.data.answer)
          : undefined;
      const matches =
        receipt?.sessionID === event.data.sessionID &&
        receipt.requestID === event.data.id &&
        (event.type === "form.cancelled"
          ? receipt.kind === "form_cancel"
          : receipt.kind === "form_reply" &&
            receipt.answerFingerprint === answer);
      const stopClosure =
        event.type === "form.cancelled" &&
        this.stopping &&
        closure?.sessionID === event.data.sessionID &&
        closure.requestID === event.data.id &&
        closure.generation === this.transport;
      if (!matches && !stopClosure)
        return this.transport.invalidate(
          "question settled outside canonical reply",
        );
      formSettlement =
        event.type === "form.cancelled" ? "cancelled" : `reply:${answer}`;
      const settled = this.formSettlements.get(event.data.id);
      if (settled !== undefined && settled !== formSettlement)
        return this.transport.invalidate("conflicting native form settlement");
    }
    if (confirmation && this.confirmed.has(confirmation)) return;
    if (!this.stopping && event.type === "permission.asked")
      this.reserve(`permission:${event.data.id}`);
    if (event.type === "form.created") {
      this.reserve(`form:${event.data.form.id}`);
      if (this.knownForms.size >= 128)
        return this.transport.invalidate("known pending form bound");
      this.knownForms.set(
        event.data.form.id,
        Object.freeze({
          sessionID: event.data.form.sessionID,
          requestID: event.data.form.id,
          generation: this.transport,
        }),
      );
    }
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
    if (
      formSettlement !== undefined &&
      !this.released &&
      (event.type === "form.replied" || event.type === "form.cancelled")
    )
      this.formSettlements.set(event.data.id, formSettlement);
    if (event.type === "permission.replied")
      this.permissions.delete(event.data.requestID);
    if (event.type === "form.replied" || event.type === "form.cancelled") {
      this.forms.delete(event.data.id);
      this.knownForms.delete(event.data.id);
    }
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

  /** Only the native interrupt mutation callback may arm these exact identities.
   * Fencing alone never authorizes closure; later form creations are not included. */
  interruptDispatched(sessionID: string): void {
    if (
      !this.stopping ||
      this.released ||
      this.transport.continuity !== "ready"
    )
      return this.transport.invalidate("invalid Stop closure dispatch");
    for (const [id, form] of this.knownForms) {
      if (form.sessionID !== sessionID) continue;
      if (!this.stopFormClosures.has(id) && this.stopFormClosures.size >= 1000)
        return this.transport.invalidate("Stop form closure receipt bound");
      this.stopFormClosures.set(id, form);
    }
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
