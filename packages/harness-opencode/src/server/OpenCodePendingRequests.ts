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
  pending: Pending;
}>;

type KnownPermission = Readonly<{
  sessionID: string;
  requestID: string;
  generation: OpenCodeClient;
  pending: Pending;
}>;

type PermissionClosure = KnownPermission &
  Readonly<{
    reason: "native_rejected" | "native_cancelled";
    /** A sibling rejection is valid only for this exact dispatched deny. */
    rejectedBy?: string;
  }>;

/** Native evidence only. EventMapper resolves this to the original canonical
 * request/item/origin; it does not infer a cancellation from an HTTP ACK. */
export type OpenCodeNativeRequestWithdrawal = Readonly<{
  requestType: "approval" | "user_input";
  sessionID: string;
  requestID: string;
  reason: "native_rejected" | "native_cancelled";
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
  private readonly knownPermissions = new Map<string, KnownPermission>();
  private readonly permissionClosures = new Map<string, PermissionClosure>();
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
      this.knownPermissions.clear();
      this.permissionClosures.clear();
      this.stopFormClosures.clear();
      this.formSettlements.clear();
    });
  }

  get pending(): number {
    return this.permissions.size + this.forms.size;
  }

  async observe(
    event: OpenCodeEvent,
    commit: (withdrawal?: OpenCodeNativeRequestWithdrawal) => Promise<void>,
  ): Promise<void> {
    if (this.released)
      return this.transport.invalidate(
        "observation after request receipt release",
      );
    // Stop revokes claims, not already-dispatched evidence. Require the exact
    // native decision/answer in every state; cancellation is not a wildcard.
    let confirmation: string | undefined;
    let formSettlement: string | undefined;
    let withdrawal: OpenCodeNativeRequestWithdrawal | undefined;
    if (event.type === "permission.replied") {
      confirmation = `permission:${event.data.requestID}`;
      const receipt = this.dispatched.get(confirmation);
      const matches =
        receipt?.kind === "permission" &&
        receipt.sessionID === event.data.sessionID &&
        receipt.requestID === event.data.requestID &&
        receipt.decision === event.data.reply;
      const closure = this.permissionClosures.get(event.data.requestID);
      const rejectingReceipt =
        closure?.rejectedBy === undefined
          ? undefined
          : this.dispatched.get(`permission:${closure.rejectedBy}`);
      const nativeClosure =
        !receipt &&
        event.data.reply === "reject" &&
        closure?.sessionID === event.data.sessionID &&
        closure.requestID === event.data.requestID &&
        closure.generation === this.transport &&
        (closure.reason === "native_cancelled"
          ? this.stopping
          : rejectingReceipt?.kind === "permission" &&
            rejectingReceipt.sessionID === closure.sessionID &&
            rejectingReceipt.requestID === closure.rejectedBy &&
            rejectingReceipt.decision === "reject");
      if (!matches && !nativeClosure)
        return this.transport.invalidate(
          "permission settled outside canonical reply",
        );
      if (nativeClosure) {
        withdrawal = {
          requestType: "approval",
          sessionID: event.data.sessionID,
          requestID: event.data.requestID,
          reason: closure.reason,
        };
      }
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
        !receipt &&
        event.type === "form.cancelled" &&
        this.stopping &&
        closure?.sessionID === event.data.sessionID &&
        closure.requestID === event.data.id &&
        closure.generation === this.transport;
      if (!matches && !stopClosure)
        return this.transport.invalidate(
          "question settled outside canonical reply",
        );
      if (!matches && stopClosure) {
        withdrawal = {
          requestType: "user_input",
          sessionID: event.data.sessionID,
          requestID: event.data.id,
          reason: "native_cancelled",
        };
      }
      formSettlement =
        event.type === "form.cancelled" ? "cancelled" : `reply:${answer}`;
      const settled = this.formSettlements.get(event.data.id);
      if (settled !== undefined && settled !== formSettlement)
        return this.transport.invalidate("conflicting native form settlement");
    }
    if (confirmation && this.confirmed.has(confirmation)) return;
    if (event.type === "permission.asked") {
      this.reserve(`permission:${event.data.id}`);
      if (this.knownPermissions.size >= 128)
        return this.transport.invalidate("known pending permission bound");
    }
    if (event.type === "form.created") {
      this.reserve(`form:${event.data.form.id}`);
      if (this.knownForms.size >= 128)
        return this.transport.invalidate("known pending form bound");
    }
    const committed = Promise.resolve().then(() => commit(withdrawal));
    if (event.type === "permission.asked") {
      const pending = {
        sessionID: event.data.sessionID,
        committed,
        claimed: false,
      };
      this.knownPermissions.set(
        event.data.id,
        Object.freeze({
          sessionID: event.data.sessionID,
          requestID: event.data.id,
          generation: this.transport,
          pending,
        }),
      );
      if (!this.stopping) this.permissions.set(event.data.id, pending);
    }
    if (event.type === "form.created") {
      const pending = {
        sessionID: event.data.form.sessionID,
        committed,
        claimed: false,
        form: structuredClone(event.data.form),
      };
      this.knownForms.set(
        event.data.form.id,
        Object.freeze({
          sessionID: pending.sessionID,
          requestID: event.data.form.id,
          generation: this.transport,
          pending,
        }),
      );
      if (!this.stopping) this.forms.set(event.data.form.id, pending);
    }
    await committed;
    if (confirmation && !this.released) this.confirmed.add(confirmation);
    if (
      formSettlement !== undefined &&
      !this.released &&
      (event.type === "form.replied" || event.type === "form.cancelled")
    )
      this.formSettlements.set(event.data.id, formSettlement);
    if (event.type === "permission.replied") {
      this.permissions.delete(event.data.requestID);
      this.knownPermissions.delete(event.data.requestID);
    }
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
    // OpenCode rejects the pending permissions in this native session. Capture
    // the exact currently observed set; neither descendants nor later requests
    // gain closure authority from this dispatch.
    const cascade =
      decision === "reject"
        ? [...this.permissions.entries()].filter(
            ([id, value]) =>
              id !== requestID && value.sessionID === pending.sessionID,
          )
        : [];
    if (cascade.some(([, value]) => value.claimed))
      return this.transport.invalidate("reject cascade races a claimed reply");
    await Promise.all(cascade.map(([, value]) => value.committed));
    await this.transport.mutate("permission.reply", (api, signal) => {
      this.assertNotStopping();
      if (decision === "reject") {
        const current = [...this.permissions.entries()].filter(
          ([id, value]) =>
            id !== requestID && value.sessionID === pending.sessionID,
        );
        if (
          current.length !== cascade.length ||
          current.some(
            ([id, value]) =>
              value.claimed ||
              !cascade.some(
                ([capturedId, captured]) =>
                  capturedId === id && captured === value,
              ),
          )
        )
          return this.transport.invalidate(
            "reject cascade scope changed before dispatch",
          );
      }
      this.remember(`permission:${requestID}`, {
        kind: "permission",
        sessionID: pending.sessionID,
        requestID,
        decision,
      });
      for (const [id, value] of cascade) {
        const known = this.knownPermissions.get(id);
        if (
          !known ||
          known.pending !== value ||
          known.generation !== this.transport
        )
          return this.transport.invalidate("reject cascade generation changed");
        this.armPermissionClosure(known, "native_rejected", requestID);
        value.claimed = true;
      }
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
    for (const [id, permission] of this.knownPermissions) {
      if (
        permission.sessionID !== sessionID ||
        this.confirmed.has(`permission:${id}`)
      )
        continue;
      // A dispatched reply retains its exact receipt, even during Stop. A claim
      // without dispatch is ambiguous, so native cancellation cannot replace it.
      if (this.dispatched.has(`permission:${id}`)) continue;
      if (permission.pending.claimed && !this.permissionClosures.has(id))
        return this.transport.invalidate(
          "Stop closure races a claimed permission",
        );
      if (!this.permissionClosures.has(id))
        this.armPermissionClosure(permission, "native_cancelled");
    }
    for (const [id, form] of this.knownForms) {
      if (form.sessionID !== sessionID) continue;
      if (this.dispatched.has(`form:${id}`)) continue;
      if (form.pending.claimed)
        return this.transport.invalidate("Stop closure races a claimed form");
      if (!this.stopFormClosures.has(id) && this.stopFormClosures.size >= 1000)
        return this.transport.invalidate("Stop form closure receipt bound");
      this.stopFormClosures.set(id, form);
    }
  }

  private armPermissionClosure(
    permission: KnownPermission,
    reason: PermissionClosure["reason"],
    rejectedBy?: string,
  ): void {
    if (
      permission.generation !== this.transport ||
      this.permissionClosures.has(permission.requestID) ||
      this.permissionClosures.size >= 1000
    )
      return this.transport.invalidate(
        "native permission closure bound or generation",
      );
    this.permissionClosures.set(
      permission.requestID,
      Object.freeze({
        ...permission,
        reason,
        ...(rejectedBy === undefined ? {} : { rejectedBy }),
      }),
    );
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
