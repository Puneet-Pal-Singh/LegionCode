import type {
  ChatImageAttachmentRef,
  ResumeTurnReceipt,
  ThreadInputCommand,
  ThreadInputConfiguration,
  ThreadInputImageSchema,
  ThreadInputReceipt,
} from "@repo/platform-protocol";
import type { StoredThreadInput, ThreadInputRepository, ThreadInputScope } from "@repo/event-store";
import type { z } from "zod";

export type InputCommand<K extends ThreadInputCommand["operation"]> = Extract<ThreadInputCommand, { operation: K }>;
export type ThreadInputTarget = Pick<InputCommand<"turn.steer">, "expectedTurnId" | "expectedRunAttemptId">;
export type PreparedThreadInputMedia = {
  readonly references: readonly ChatImageAttachmentRef[];
  readonly fingerprint: string | null;
  readonly mediaRevision: number | null;
  /** The adapter checks the actual durable row after the original mutation settles. */
  discardUnpublished(): Promise<void>;
};

/** Placement adapters supply effects. This service owns no environment, HTTP
 * request, process, second inbox or client-side dispatch loop. */
export interface ThreadInputCommandPorts {
  readonly repository: ThreadInputRepository;
  authorize(identity: { threadId: string; workspaceId: string }): Promise<ThreadInputScope>;
  validateConfiguration(configuration: ThreadInputConfiguration): void | Promise<void>;
  prepareMedia(input: {
    readonly scope: ThreadInputScope;
    readonly inputId: string;
    readonly clientInputId: string;
    readonly mediaRevision: number;
    readonly images: readonly z.infer<typeof ThreadInputImageSchema>[];
  }): Promise<PreparedThreadInputMedia>;
  assertSteeringTarget(scope: ThreadInputScope, target: ThreadInputTarget, hasImages: boolean): Promise<void | Extract<ThreadInputReceipt, { status: "conflict" }>>;
  /** Only an explicit known pre-acceptance conflict returns a conflict receipt.
   * A throw can follow durable acceptance and must remain unknown. */
  deliverSteer(scope: ThreadInputScope, item: StoredThreadInput): Promise<
    { readonly acceptedSequence: number } | Extract<ThreadInputReceipt, { status: "conflict" }>
  >;
  /** Must include actual physical cleanup, never infer idle from a latest-run pointer. */
  proveIdle(scope: ThreadInputScope): Promise<"idle" | "active" | "unknown">;
  /** Storage adapter atomically consumes the item with canonical admission. */
  startQueued(input: {
    readonly scope: ThreadInputScope;
    readonly command: InputCommand<"thread.input.start">;
    readonly explicitStart: boolean;
  }): Promise<ThreadInputReceipt>;
  resume?(scope: ThreadInputScope, command: InputCommand<"turn.resume">): Promise<ResumeTurnReceipt>;
}
