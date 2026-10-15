import { z } from "zod";
import {
  ChatImageAttachmentRefSchema,
  ChatMediaImageTypeSchema,
  ProductModeSchema,
  ReasoningEffortSchema,
} from "@repo/shared-types";
import { EventSequenceSchema } from "./common.js";
import {
  ModelIdSchema,
  ProviderIdSchema,
  RunIdSchema,
  RunAttemptIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
} from "./ids.js";
import { RunModeSchema } from "./conversation.js";
import { WorkspaceScopeIdSchema } from "./turn-scope-bootstrap.js";

const ClientCommandIdSchema = z.string().trim().min(1).max(200);
const ClientInputIdSchema = z.string().trim().min(1).max(200);
const ThreadInputIdSchema = z.string().uuid();
const QueueVersionSchema = z.number().int().positive().safe();
const QueueOrderSchema = z.number().int().positive().safe();

export const ThreadInputImageSchema = z
  .object({
    dataUrl: z.string().min(1).max(7_100_000),
    name: z.string().trim().min(1).max(255),
    mediaType: ChatMediaImageTypeSchema,
  })
  .strict();

export const ThreadInputContentSchema = z
  .object({
    text: z.string().max(100_000),
    images: z.array(ThreadInputImageSchema).max(8),
  })
  .strict()
  .refine((value) => value.text.trim().length > 0 || value.images.length > 0, {
    message: "Provide text or at least one image.",
  });

export const ThreadInputUpdateContentSchema = z
  .object({
    text: z.string().max(100_000),
    images: z.array(ThreadInputImageSchema).max(8).optional(),
  })
  .strict();

export const ThreadInputConfigurationSchema = z
  .object({
    mode: RunModeSchema.optional(),
    providerId: ProviderIdSchema.optional(),
    modelId: ModelIdSchema.optional(),
    reasoningEffort: ReasoningEffortSchema.optional(),
    productMode: ProductModeSchema.optional(),
    harnessId: z.enum(["cloudflare-sandbox", "local-sandbox"]).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.providerId === undefined) !== (value.modelId === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provider and model must be supplied together",
        path: ["providerId"],
      });
    }
  });
export type ThreadInputConfiguration = z.infer<
  typeof ThreadInputConfigurationSchema
>;

export const StartedThreadInputReceiptSchema = z.object({
  status: z.literal("started"),
  itemId: ThreadInputIdSchema,
  turnId: TurnIdSchema,
  runAttemptId: RunAttemptIdSchema,
  runId: RunIdSchema,
}).strict();
export type StartedThreadInputReceipt = z.infer<typeof StartedThreadInputReceiptSchema>;

const ThreadWorkspaceScopeSchema = z
  .object({
    threadId: ThreadIdSchema,
    workspaceId: WorkspaceScopeIdSchema,
  })
  .strict();

export const ResumeTurnCommandSchema = ThreadWorkspaceScopeSchema.extend({
  operation: z.literal("turn.resume"),
  clientCommandId: ClientCommandIdSchema,
  expectedTurnId: TurnIdSchema,
  expectedRunAttemptId: RunAttemptIdSchema,
  expectedTerminalSequence: EventSequenceSchema,
  configuration: ThreadInputConfigurationSchema.optional(),
}).strict();

export const SteerTurnCommandSchema = ThreadWorkspaceScopeSchema.extend({
  operation: z.literal("turn.steer"),
  clientInputId: ClientInputIdSchema,
  expectedTurnId: TurnIdSchema,
  expectedRunAttemptId: RunAttemptIdSchema,
  content: ThreadInputContentSchema,
}).strict();

export const EnqueueThreadInputCommandSchema = ThreadWorkspaceScopeSchema.extend({
  operation: z.literal("thread.input.enqueue"),
  clientInputId: ClientInputIdSchema,
  content: ThreadInputContentSchema,
  configuration: ThreadInputConfigurationSchema,
}).strict();

export const ListThreadInputsCommandSchema = ThreadWorkspaceScopeSchema.extend({
  operation: z.literal("thread.input.list"),
  knownRevision: z.number().int().nonnegative().safe().optional(),
}).strict();

export const UpdateThreadInputCommandSchema = ThreadWorkspaceScopeSchema.extend({
  operation: z.literal("thread.input.update"),
  itemId: ThreadInputIdSchema,
  expectedVersion: QueueVersionSchema,
  content: ThreadInputUpdateContentSchema,
  configuration: ThreadInputConfigurationSchema.optional(),
}).strict();

export const RemoveThreadInputCommandSchema = ThreadWorkspaceScopeSchema.extend({
  operation: z.literal("thread.input.remove"),
  itemId: ThreadInputIdSchema,
  expectedVersion: QueueVersionSchema,
}).strict();

export const SteerQueuedThreadInputCommandSchema = ThreadWorkspaceScopeSchema.extend({
  operation: z.literal("thread.input.steer"),
  itemId: ThreadInputIdSchema,
  expectedVersion: QueueVersionSchema,
  expectedTurnId: TurnIdSchema,
  expectedRunAttemptId: RunAttemptIdSchema,
}).strict();

export const StartQueuedThreadInputCommandSchema = ThreadWorkspaceScopeSchema.extend({
  operation: z.literal("thread.input.start"),
  itemId: ThreadInputIdSchema,
  expectedVersion: QueueVersionSchema,
  expectedThreadRevision: z.number().int().nonnegative().safe(),
}).strict();

export const ThreadInputCommandSchema = z.discriminatedUnion("operation", [
  ResumeTurnCommandSchema,
  SteerTurnCommandSchema,
  EnqueueThreadInputCommandSchema,
  ListThreadInputsCommandSchema,
  UpdateThreadInputCommandSchema,
  RemoveThreadInputCommandSchema,
  SteerQueuedThreadInputCommandSchema,
  StartQueuedThreadInputCommandSchema,
]);
export type ThreadInputCommand = z.infer<typeof ThreadInputCommandSchema>;

export const ThreadInputReceiptSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("accepted"),
    clientInputId: ClientInputIdSchema,
    inputId: ThreadInputIdSchema,
    targetTurnId: TurnIdSchema,
    targetRunAttemptId: RunAttemptIdSchema,
    acceptedSequence: EventSequenceSchema,
  }).strict(),
  z.object({
    status: z.literal("pending"),
    clientInputId: ClientInputIdSchema,
    itemId: ThreadInputIdSchema,
    order: QueueOrderSchema,
    version: QueueVersionSchema,
    revision: z.number().int().positive().safe(),
  }).strict(),
  z.object({
    status: z.literal("cancelled"),
    itemId: ThreadInputIdSchema,
    version: QueueVersionSchema,
    revision: z.number().int().positive().safe(),
  }).strict(),
  z.object({
    status: z.literal("applied"),
    inputId: ThreadInputIdSchema,
    targetTurnId: TurnIdSchema,
    targetRunAttemptId: RunAttemptIdSchema,
    acceptedSequence: EventSequenceSchema,
    appliedSequence: EventSequenceSchema,
    modelStep: z.number().int().positive().safe(),
    contextRevision: z.number().int().nonnegative().safe(),
  }).strict(),
  z.object({
    status: z.literal("unconfirmed"),
    inputId: ThreadInputIdSchema,
    targetTurnId: TurnIdSchema,
    targetRunAttemptId: RunAttemptIdSchema,
    acceptedSequence: EventSequenceSchema,
    terminalSequence: EventSequenceSchema,
  }).strict(),
  StartedThreadInputReceiptSchema,
  z.object({
    status: z.literal("conflict"),
    code: z.enum([
      "target_superseded",
      "turn_not_active",
      "turn_not_interrupted",
      "queue_item_changed",
      "queue_item_consumed",
      "queue_revision_conflict",
      "queue_paused",
      "thread_not_idle",
      "history_incomplete",
      "workspace_snapshot_unavailable",
    ]),
    message: z.string().max(2_000),
  }).strict(),
]);
export type ThreadInputReceipt = z.infer<typeof ThreadInputReceiptSchema>;

export const ResumeTurnReceiptSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("resumed"),
    clientCommandId: ClientCommandIdSchema,
    continuationOfTurnId: TurnIdSchema,
    originalPromptId: z.string().trim().min(1).max(200),
    turnId: TurnIdSchema,
    runAttemptId: RunAttemptIdSchema,
    runId: RunIdSchema,
  }).strict(),
  z.object({
    status: z.literal("conflict"),
    code: z.enum([
      "target_superseded",
      "turn_not_interrupted",
      "history_incomplete",
      "workspace_snapshot_unavailable",
    ]),
    message: z.string().max(2_000),
  }).strict(),
]);
export type ResumeTurnReceipt = z.infer<typeof ResumeTurnReceiptSchema>;

export const ThreadInputQueueItemSchema = z
  .object({
    itemId: ThreadInputIdSchema,
    clientInputId: ClientInputIdSchema,
    order: QueueOrderSchema,
    version: QueueVersionSchema,
    state: z.enum(["pending", "consuming", "consumed", "cancelled"]),
    delivery: z.enum(["queue", "steer"]),
    targetTurnId: TurnIdSchema.nullable(),
    targetRunAttemptId: RunAttemptIdSchema.nullable(),
    text: z.string().max(100_000),
    mediaRefs: z.array(ChatImageAttachmentRefSchema).max(8),
    configuration: ThreadInputConfigurationSchema,
    receipt: ThreadInputReceiptSchema.nullable(),
  })
  .strict();
export type ThreadInputQueueItem = z.infer<typeof ThreadInputQueueItemSchema>;

export const ThreadInputQueueSnapshotSchema = z
  .object({
    threadId: ThreadIdSchema,
    workspaceId: WorkspaceScopeIdSchema,
    revision: z.number().int().nonnegative().safe(),
    paused: z.boolean(),
    pauseReason: z.string().max(2_000).nullable(),
    activeRunId: RunIdSchema.nullable().default(null),
    latestStarted: z.object({
      order: QueueOrderSchema,
      receipt: StartedThreadInputReceiptSchema,
    }).strict().nullable().default(null),
    items: z.array(ThreadInputQueueItemSchema).max(500),
  })
  .strict();
export type ThreadInputQueueSnapshot = z.infer<
  typeof ThreadInputQueueSnapshotSchema
>;
