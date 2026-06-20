import { z } from "zod";
import {
  ApprovalStatusSchema,
  ItemKindSchema,
  ItemStatusSchema,
  ToolCallStatusSchema,
  TurnBlockingStateSchema,
  TurnTerminalOutcomeSchema,
  type ApprovalStatus,
  type ItemKind,
  type ItemStatus,
  type ToolCallStatus,
  type TurnBlockingState,
  type TurnTerminalOutcome,
} from "@repo/platform-protocol/lifecycle";

export const LIFECYCLE_PROJECTION_VERSION = 1;

export interface LifecycleItemProjection {
  readonly itemId: string;
  readonly kind: ItemKind;
  readonly status: ItemStatus;
  readonly text: string;
  readonly lastSequence: number;
}

export interface LifecycleToolCallProjection {
  readonly toolCallId: string;
  readonly itemId: string;
  readonly status: ToolCallStatus;
  readonly outputText: string;
  readonly lastSequence: number;
}

export interface LifecycleApprovalProjection {
  readonly approvalId: string;
  readonly itemId: string;
  readonly status: ApprovalStatus;
  readonly lastSequence: number;
}

export interface LifecycleRequestProjection {
  readonly requestId: string;
  readonly itemId: string;
  readonly status: "pending" | "resolved";
  readonly lastSequence: number;
}

export interface LifecycleProjectionSnapshot {
  readonly turnId: string;
  readonly status: "queued" | "in_progress" | "completed" | "interrupted" | "failed";
  readonly blockingState: TurnBlockingState;
  readonly terminalOutcome: TurnTerminalOutcome | null;
  readonly items: readonly LifecycleItemProjection[];
  readonly toolCalls: readonly LifecycleToolCallProjection[];
  readonly approvals: readonly LifecycleApprovalProjection[];
  readonly requests: readonly LifecycleRequestProjection[];
  readonly lastSequence: number;
  readonly projectionVersion: typeof LIFECYCLE_PROJECTION_VERSION;
}

export const LifecycleItemProjectionSchema = z.object({
  itemId: z.string().min(1),
  kind: ItemKindSchema,
  status: ItemStatusSchema,
  text: z.string(),
  lastSequence: z.number().int().nonnegative(),
});

export const LifecycleToolCallProjectionSchema = z.object({
  toolCallId: z.string().min(1),
  itemId: z.string().min(1),
  status: ToolCallStatusSchema,
  outputText: z.string(),
  lastSequence: z.number().int().nonnegative(),
});

export const LifecycleApprovalProjectionSchema = z.object({
  approvalId: z.string().min(1),
  itemId: z.string().min(1),
  status: ApprovalStatusSchema,
  lastSequence: z.number().int().nonnegative(),
});

export const LifecycleProjectionSnapshotSchema = z.object({
  turnId: z.string().min(1),
  status: z.enum(["queued", "in_progress", "completed", "interrupted", "failed"]),
  blockingState: TurnBlockingStateSchema,
  terminalOutcome: TurnTerminalOutcomeSchema.nullable(),
  items: z.array(LifecycleItemProjectionSchema),
  toolCalls: z.array(LifecycleToolCallProjectionSchema),
  approvals: z.array(LifecycleApprovalProjectionSchema),
  requests: z.array(
    z.object({
      requestId: z.string().min(1),
      itemId: z.string().min(1),
      status: z.enum(["pending", "resolved"]),
      lastSequence: z.number().int().nonnegative(),
    }),
  ),
  lastSequence: z.number().int().nonnegative(),
  projectionVersion: z.literal(LIFECYCLE_PROJECTION_VERSION),
});

export class LifecycleProjectionError extends Error {
  constructor(
    readonly code: "sequence_gap" | "identity_mismatch" | "corrupt_event",
    message: string,
  ) {
    super(message);
    this.name = "LifecycleProjectionError";
  }
}
