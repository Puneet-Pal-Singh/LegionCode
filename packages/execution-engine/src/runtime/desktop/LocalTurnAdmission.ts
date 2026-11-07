import { randomUUID } from "node:crypto";
import {
  RunSchema,
  TurnSchema,
  ThreadSchema,
  ThreadItemSchema,
  RunIdSchema,
  ItemIdSchema,
  createTurnId,
  createRunAttemptId,
  type Run,
  type Thread,
  type WorkspaceId,
} from "@repo/platform-protocol";
import type { TurnAdmission } from "@repo/platform-protocol/conversation";

export interface LocalTurnAdmissionInput {
  readonly thread: Thread;
  readonly workspaceId: WorkspaceId;
  readonly clientRequestId: string;
  readonly prompt: string;
  readonly providerId: Run["providerId"];
  readonly modelId: Run["modelId"];
  readonly workerId: Run["workerId"];
  readonly permissionProfileId: Run["permissionProfileId"];
}

/** Runtime creates initial product records; callers supply trusted selection and identities. */
export function createLocalTurnAdmission(
  input: LocalTurnAdmissionInput,
): TurnAdmission {
  const thread = ThreadSchema.parse(input.thread);
  if (thread.workspaceId !== input.workspaceId || thread.status !== "active") {
    throw new Error(
      "Local turn requires an active thread in the granted workspace",
    );
  }
  if (
    !input.clientRequestId.trim() ||
    input.clientRequestId.length > 200 ||
    !input.prompt.trim() ||
    input.prompt.length > 200_000
  ) {
    throw new Error("Local turn requires a bounded request key and prompt");
  }
  const now = new Date().toISOString();
  const run = RunSchema.parse({
    id: RunIdSchema.parse(`run_${randomUUID().replaceAll("-", "")}`),
    threadId: thread.id,
    userId: thread.userId,
    workspaceId: thread.workspaceId,
    status: "queued",
    mode: "ask",
    providerId: input.providerId,
    modelId: input.modelId,
    workerId: input.workerId,
    permissionProfileId: input.permissionProfileId,
    executionCapability: "repository",
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    lastEventSequence: 0,
  });
  const turn = TurnSchema.parse({
    id: createTurnId(),
    threadId: thread.id,
    runId: run.id,
    parentTurnId: null,
    status: "queued",
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    lastEventSequence: 0,
  });
  const userMessage = ThreadItemSchema.parse({
    id: ItemIdSchema.parse(`itm_${randomUUID().replaceAll("-", "")}`),
    threadId: thread.id,
    runId: run.id,
    turnId: turn.id,
    parentItemId: thread.activeLeafItemId,
    branchId: null,
    type: "user_message",
    role: "user",
    status: "completed",
    content: { text: input.prompt },
    createdAt: now,
    completedAt: now,
    eventSequence: 0,
  });
  return {
    clientRequestId: input.clientRequestId.trim(),
    run,
    turn,
    runAttemptId: createRunAttemptId(),
    userMessage,
  };
}
