import type { z } from "zod";
import type {
  ChatImageAttachmentRef,
  ChatMediaImageType,
  RunAttemptId,
  RunId,
  ThreadId,
  ThreadInputImageSchema,
  TurnId,
  UserId,
  WorkspaceId,
  LocalTurnMediaLimits,
} from "@repo/platform-protocol";

export interface LocalTurnMediaScope {
  readonly userId: UserId;
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly turnId: TurnId;
  readonly runAttemptId: RunAttemptId;
}

/** Private provider ingress, never serialized through transcript or renderer IPC. */
export interface LocalProviderImagePart {
  readonly type: "image";
  readonly image: string;
  readonly mimeType: ChatMediaImageType;
}

export interface LocalTurnPreparedMedia {
  /** Canonical codec owner's digest of the ordered, validated image inputs. */
  readonly fingerprint: string;
  persist(scope: LocalTurnMediaScope): Promise<readonly ChatImageAttachmentRef[]>;
}

/** The concrete owner keeps bytes outside the durable admission/lifecycle payloads. */
export interface LocalTurnMediaPort {
  readonly limits: LocalTurnMediaLimits;
  /** Map dataUrl -> IncomingChatImage.image; preserve name/mediaType. The shared
   * codec must decode, sniff and normalize before returning this preparation.
   * No caller-supplied filename becomes an object path.
   */
  prepare(
    images: readonly z.infer<typeof ThreadInputImageSchema>[],
    signal?: AbortSignal,
  ): Promise<LocalTurnPreparedMedia>;
  resolveForProvider(input: {
    readonly scope: LocalTurnMediaScope;
    readonly references: readonly ChatImageAttachmentRef[];
    readonly signal?: AbortSignal;
  }): Promise<readonly LocalProviderImagePart[]>;
}
