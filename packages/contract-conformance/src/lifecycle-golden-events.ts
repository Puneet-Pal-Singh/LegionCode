import {
  LifecycleEventSchema,
  type ItemKind,
  type LifecycleEvent,
  type TurnTerminalOutcome,
} from "@repo/platform-protocol/lifecycle";
import type { ProtocolError } from "@repo/platform-protocol/errors";
import type { GoldenChangedFile } from "./lifecycle-golden-types.js";

interface GoldenEventRefs {
  readonly itemId?: string;
  readonly toolCallId?: string;
  readonly approvalId?: string;
  readonly requestId?: string;
  readonly runAttemptId?: string;
}

export interface GoldenEventContext {
  readonly slug: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly runAttemptId: string;
}

const timestamp = "2026-06-23T00:00:00.000Z";

export function createGoldenContext(slug: string): GoldenEventContext {
  return {
    slug,
    threadId: `thr_${slug}thread`,
    turnId: `trn_${slug}turn`,
    runAttemptId: runAttemptId(slug, "primary"),
  };
}

export function itemId(context: GoldenEventContext, suffix: string): string {
  return `itm_${context.slug}${suffix}`;
}

export function toolCallId(context: GoldenEventContext, suffix: string): string {
  return `toolcall_${context.slug}${suffix}`;
}

export function approvalId(context: GoldenEventContext, suffix: string): string {
  return `appr_${context.slug}${suffix}`;
}

export function requestId(context: GoldenEventContext, suffix: string): string {
  return `request_${context.slug}${suffix}`;
}

export function runAttemptId(slug: string, suffix: string): string {
  return `attempt_${slug}${suffix}`;
}

export function event(
  context: GoldenEventContext,
  sequence: number,
  type: LifecycleEvent["type"],
  payload: Record<string, unknown> = {},
  refs: GoldenEventRefs = {},
): LifecycleEvent {
  return LifecycleEventSchema.parse({
    eventId: `evt_${context.slug}${String(sequence).padStart(3, "0")}`,
    threadId: context.threadId,
    turnId: context.turnId,
    runAttemptId: refs.runAttemptId ?? context.runAttemptId,
    sequence,
    idempotencyKey: `${context.slug}:${sequence}`,
    producer: { kind: "runtime_kernel", id: "golden-matrix" },
    schemaVersion: 1,
    createdAt: timestamp,
    type,
    payload,
    ...refs,
  });
}

export function itemStarted(
  context: GoldenEventContext,
  sequence: number,
  id: string,
  kind: ItemKind,
  refs: GoldenEventRefs = {},
): LifecycleEvent {
  return event(context, sequence, "item.started", { kind }, { ...refs, itemId: id });
}

export function itemCompleted(
  context: GoldenEventContext,
  sequence: number,
  id: string,
  refs: GoldenEventRefs = {},
): LifecycleEvent {
  return event(context, sequence, "item.completed", { result: {} }, { ...refs, itemId: id });
}

export function itemFailed(
  context: GoldenEventContext,
  sequence: number,
  id: string,
  failure: ProtocolError,
  refs: GoldenEventRefs = {},
): LifecycleEvent {
  return event(context, sequence, "item.failed", { failure }, { ...refs, itemId: id });
}

export function itemInterrupted(
  context: GoldenEventContext,
  sequence: number,
  id: string,
  reason: string,
  refs: GoldenEventRefs = {},
): LifecycleEvent {
  return event(context, sequence, "item.interrupted", { reason }, { ...refs, itemId: id });
}

export function itemDeclined(
  context: GoldenEventContext,
  sequence: number,
  id: string,
  reason: string,
): LifecycleEvent {
  return event(context, sequence, "item.declined", { reason }, { itemId: id });
}

export function toolEvent(
  context: GoldenEventContext,
  sequence: number,
  type: LifecycleEvent["type"],
  id: string,
  callId: string,
  payload: Record<string, unknown>,
  refs: GoldenEventRefs = {},
): LifecycleEvent {
  return event(context, sequence, type, payload, {
    ...refs,
    itemId: id,
    toolCallId: callId,
  });
}

export function terminalEvent(
  context: GoldenEventContext,
  sequence: number,
  type: "turn.completed" | "turn.interrupted" | "turn.failed",
  outcome: TurnTerminalOutcome,
  refs: GoldenEventRefs = {},
): LifecycleEvent {
  return event(context, sequence, type, { outcome }, refs);
}

export function turnDiffUpdated(
  context: GoldenEventContext,
  sequence: number,
  files: readonly GoldenChangedFile[],
): LifecycleEvent {
  return event(context, sequence, "turn.diff_updated", { files });
}

export function protocolFailure(message: string): ProtocolError {
  return {
    code: "internal_error",
    message,
    retryable: false,
    correlationId: null,
    details: null,
  };
}
