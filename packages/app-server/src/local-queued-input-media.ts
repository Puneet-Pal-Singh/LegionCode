import { z } from "zod";
import {
  ChatImageAttachmentRefSchema, ContentDigestSchema, ThreadIdSchema,
  ThreadInputQueueItemSchema, UserIdSchema, WorkspaceIdSchema,
  type ChatImageAttachmentRef, type LocalTurnMediaLimits,
} from "@repo/platform-protocol";
import type { LocalProviderImagePart, LocalTurnMediaPort, LocalTurnPreparedMedia } from "./local-turn-media.js";
import { MAX_LOCAL_APP_SERVER_IMAGES } from "./protocol.js";

/** Actual canonical queue identity; media revision survives unrelated row edits.
 * No future Run, Turn or attempt identity is manufactured for queued bytes. */
export const LocalQueuedInputMediaScopeSchema = z.object({
  userId: UserIdSchema, workspaceId: WorkspaceIdSchema, threadId: ThreadIdSchema,
  inputId: ThreadInputQueueItemSchema.shape.itemId,
  mediaRevision: ThreadInputQueueItemSchema.shape.version,
}).strict();
export type LocalQueuedInputMediaScope = z.infer<typeof LocalQueuedInputMediaScopeSchema>;

export const LocalQueuedInputMediaOwnershipSchema = z.object({
  scope: LocalQueuedInputMediaScopeSchema,
  fingerprint: ContentDigestSchema,
  references: z.array(ChatImageAttachmentRefSchema).min(1).max(MAX_LOCAL_APP_SERVER_IMAGES),
}).strict();
export type LocalQueuedInputMediaOwnership = z.infer<typeof LocalQueuedInputMediaOwnershipSchema>;
/** Same SQLite queue owner. Null proves exact batch absence; unavailable or
 * conflicting ownership must throw or return its actual nonmatching receipt. */
export type LocalQueuedInputMediaLookup = (scope: LocalQueuedInputMediaScope) => Promise<LocalQueuedInputMediaOwnership | null>;

export interface LocalQueuedInputPreparedMedia {
  readonly fingerprint: string;
  persist(scope: LocalQueuedInputMediaScope): Promise<readonly ChatImageAttachmentRef[]>;
  /** Caller first drains its ORIGINAL canonical queue publication/update. */
  discardUnadmitted(confirmScopeAbsence: (scope: LocalQueuedInputMediaScope) => Promise<boolean>): Promise<boolean>;
}

export interface LocalQueuedInputMediaRead extends LocalQueuedInputMediaOwnership {
  readonly signal?: AbortSignal;
}

/** Private bytes/codec capability only. Queue ownership, claims, admission,
 * steering acceptance and replay remain with their existing canonical owners. */
export interface LocalQueuedInputMediaPort {
  readonly limits: LocalTurnMediaLimits;
  prepareQueued(images: Parameters<LocalTurnMediaPort["prepare"]>[0], signal?: AbortSignal): Promise<LocalQueuedInputPreparedMedia>;
  promoteQueued(input: LocalQueuedInputMediaRead): Promise<LocalTurnPreparedMedia>;
  resolveQueuedForProvider(input: LocalQueuedInputMediaRead): Promise<readonly LocalProviderImagePart[]>;
}
