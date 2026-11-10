import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { ChatImageAttachmentRefSchema, TurnAdmissionSchema, type TurnAdmission } from "@repo/platform-protocol";
import { LocalChatMediaFiles } from "./local-chat-media-files.js";
import { LocalChatMediaJournal, type LocalChatMediaPendingRecord } from "./local-chat-media-journal.js";
import {
  LocalChatMediaScopeSchema, LOCAL_CHAT_MEDIA_LIMITS, LocalChatMediaError,
  mediaScopeKey,
  type LocalChatMediaRecord, type LocalDecodedChatImage,
} from "./local-chat-media-records.js";
import type { LocalTurnMediaScope } from "./local-turn-media.js";

export type LocalChatMediaAdmissionLookup = (scope: LocalTurnMediaScope) => Promise<TurnAdmission | null>;

/** Canonical admissions are the only acceptance authority. This queue and
 * journal own temporary byte resources only; no event or admission is written. */
export class LocalChatMediaResources {
  private readonly journal: LocalChatMediaJournal;
  private recovery?: Promise<void>;
  private mutations: Promise<void> = Promise.resolve();
  private readonly recoverableScopes = new Set<string>();
  constructor(
    private readonly files: LocalChatMediaFiles,
    storageDirectory: string,
    private readonly lookupAdmission?: LocalChatMediaAdmissionLookup,
  ) { this.journal = new LocalChatMediaJournal(storageDirectory); }

  ready(): Promise<void> {
    // Before this resolves no preparation token can begin current-owner writes.
    // Only the fresh exclusive canonical DB owner may confirm recovery absence.
    return this.recovery ??= this.serialize(async () => {
      await this.files.ready();
      const scan = await this.journal.scan();
      for (const pending of scan.records) this.recoverableScopes.add(mediaScopeKey(pending.record.scope));
      for (const pending of scan.records) {
        const state = await this.acceptance(pending.record);
        if (state === "accepted") await this.clearAccepted(pending).catch(() => undefined);
        else if (state === "absent" && !scan.blocked) await this.discard(pending).catch(() => undefined);
        // Unavailable lookup, corrupt/foreign metadata and unknown files retain
        // their reservation. They cannot silently expand the pending quota.
      }
    });
  }

  async publish(record: LocalChatMediaRecord, images: readonly LocalDecodedChatImage[], signal?: AbortSignal): Promise<void> {
    await this.ready();
    return this.serialize(async () => {
      signal?.throwIfAborted();
      this.recoverableScopes.delete(mediaScopeKey(record.scope));
      // Live absence cleanup is limited to old-owner or explicitly settled
      // request resources. Other current requests may still be about to admit.
      const scan = await this.journal.scan();
      for (const pending of scan.records) {
        const state = await this.acceptance(pending.record);
        if (state === "accepted") {
          await this.clearAccepted(pending).catch(() => undefined);
        } else if (state === "absent" && !scan.blocked && this.recoverableScopes.has(mediaScopeKey(pending.record.scope))) {
          await this.discard(pending).catch(() => undefined);
        }
      }
      if (await this.files.hasBatch(record.scope)) {
        await this.files.verify(record);
        return; // Never claim a pre-existing unjournaled batch as disposable.
      }
      if (await this.files.hasStage(record.scope) && !scan.records.some((entry) =>
        isDeepStrictEqual(entry.record, record))) {
        throw new LocalChatMediaError("unavailable", "Unrecognized image staging evidence has been retained");
      }
      await this.journal.reserve(record); // Durable quota reservation precedes bytes.
      await this.files.publish(record, images, signal);
    });
  }

  async discardUnadmitted(
    record: LocalChatMediaRecord,
    confirmScopeAbsence: (scope: LocalTurnMediaScope) => Promise<boolean>,
  ): Promise<boolean> {
    await this.ready();
    return this.serialize(async () => {
      const key = mediaScopeKey(record.scope);
      // Invocation is permitted only after the caller's actual admit attempt
      // settles. A later fresh lookup may retry an initially unavailable proof.
      this.recoverableScopes.add(key);
      try {
        const scan = await this.journal.scan();
        const pending = scan.records.find((entry) => isDeepStrictEqual(entry.record, record));
        if (!pending) {
          this.recoverableScopes.delete(key);
          return !scan.blocked && !(scan.records.some((entry) => isDeepStrictEqual(entry.record.scope, record.scope)));
        }
        const state = await this.acceptance(record);
        if (state === "accepted") return await this.clearAccepted(pending);
        if (state === "unknown" && this.lookupAdmission) return false;
        let absent = false;
        try { absent = await confirmScopeAbsence(LocalChatMediaScopeSchema.parse(record.scope)); }
        catch { return false; }
        if (!absent) return false;
        await this.discard(pending);
        return true;
      } catch { return false; }
    });
  }
  private async discard(pending: LocalChatMediaPendingRecord): Promise<void> {
    await this.files.discardPending(pending.record,
      () => this.journal.markDiscarding(pending), pending.phase === "discarding");
    await this.journal.remove(pending);
    this.recoverableScopes.delete(mediaScopeKey(pending.record.scope));
  }
  private async clearAccepted(pending: LocalChatMediaPendingRecord): Promise<boolean> {
    await this.files.verify(pending.record);
    // Unexpected staged evidence is retained and remains quota-bound.
    if (await this.files.hasStage(pending.record.scope)) return false;
    await this.journal.remove(pending); // Accepted original batch is never changed.
    this.recoverableScopes.delete(mediaScopeKey(pending.record.scope));
    return true;
  }
  private async acceptance(record: LocalChatMediaRecord): Promise<"accepted" | "absent" | "unknown"> {
    if (!this.lookupAdmission) return "unknown";
    try {
      const raw = await this.lookupAdmission(record.scope);
      if (raw === null) return "absent";
      const admission = TurnAdmissionSchema.parse(raw);
      const scope = LocalChatMediaScopeSchema.parse({
        userId: admission.run.userId, workspaceId: admission.run.workspaceId,
        threadId: admission.run.threadId, runId: admission.run.id,
        turnId: admission.turn.id, runAttemptId: admission.runAttemptId,
      });
      const prompt = admission.userMessage;
      if (!isDeepStrictEqual(scope, record.scope) || prompt.type !== "user_message" ||
        prompt.content.imageFingerprint !== record.fingerprint) return "unknown";
      const references = z.array(ChatImageAttachmentRefSchema).max(LOCAL_CHAT_MEDIA_LIMITS.maxImages).parse(prompt.content.images);
      return isDeepStrictEqual(references, record.images.map(({ reference }) => reference)) ? "accepted" : "unknown";
    } catch { return "unknown"; }
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation);
    this.mutations = result.then(() => undefined, () => undefined);
    return result;
  }
}
