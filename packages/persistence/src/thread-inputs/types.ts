import type {
  ThreadInputConfiguration,
  ThreadInputQueueItem,
  ThreadInputQueueSnapshot,
  ThreadInputReceipt,
} from "@repo/platform-protocol";

export interface ThreadInputScope {
  readonly sessionId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly workspaceId: string;
}

export interface StoredThreadInput extends ThreadInputQueueItem {
  readonly sessionId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly workspaceId: string;
  readonly fingerprint: string;
  readonly delivery: "queue" | "steer";
  readonly targetTurnId: ThreadInputQueueItem["targetTurnId"];
  readonly targetRunAttemptId: ThreadInputQueueItem["targetRunAttemptId"];
}

export interface CreateThreadInput extends ThreadInputScope {
  readonly clientInputId: string;
  readonly fingerprint: string;
  readonly delivery: "queue" | "steer";
  readonly targetTurnId?: NonNullable<ThreadInputQueueItem["targetTurnId"]>;
  readonly targetRunAttemptId?: NonNullable<ThreadInputQueueItem["targetRunAttemptId"]>;
  readonly text: string;
  readonly mediaRefs: ThreadInputQueueItem["mediaRefs"];
  readonly configuration: ThreadInputConfiguration;
}

export interface UpdateThreadInput extends ThreadInputScope {
  readonly itemId: string;
  readonly expectedVersion: number;
  readonly text: string;
  readonly mediaRefs?: ThreadInputQueueItem["mediaRefs"];
  readonly configuration?: ThreadInputConfiguration;
}

export interface ClaimQueuedInputForSteering extends ThreadInputScope {
  readonly itemId: string;
  readonly expectedVersion: number;
  readonly targetTurnId: NonNullable<ThreadInputQueueItem["targetTurnId"]>;
  readonly targetRunAttemptId: NonNullable<ThreadInputQueueItem["targetRunAttemptId"]>;
}

export type ThreadInputMutation =
  | { readonly status: "changed"; readonly item: StoredThreadInput; readonly revision: number }
  | { readonly status: "conflict"; readonly code: "queue_item_changed" | "queue_item_consumed" };

export interface ThreadInputRepository {
  enqueue(input: CreateThreadInput): Promise<{ item: StoredThreadInput; revision: number; duplicate: boolean }>;
  list(input: ThreadInputScope): Promise<ThreadInputQueueSnapshot>;
  getById(input: ThreadInputScope & { itemId: string }): Promise<StoredThreadInput | null>;
  update(input: UpdateThreadInput): Promise<ThreadInputMutation>;
  claimForSteering(input: ClaimQueuedInputForSteering): Promise<ThreadInputMutation & { readonly revision?: number }>;
  remove(input: ThreadInputScope & { itemId: string; expectedVersion: number }): Promise<ThreadInputMutation>;
  setPaused(input: ThreadInputScope & { paused: boolean; reason: string | null }): Promise<number>;
  recordReceipt(input: ThreadInputScope & { itemId: string; expectedVersion: number; receipt: ThreadInputReceipt; state: StoredThreadInput["state"] }): Promise<ThreadInputMutation>;
}
