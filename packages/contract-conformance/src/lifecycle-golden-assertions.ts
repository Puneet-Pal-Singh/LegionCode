import {
  LifecycleEventSchema,
  LifecycleTransitionError,
  type ApprovalStatus,
  type ItemStatus,
  type LifecycleEvent,
  type RunAttemptStatus,
  type ToolCallStatus,
} from "@repo/platform-protocol/lifecycle";
import { expect } from "vitest";
import {
  replayLifecycleEvents,
  type LifecycleEventLogContract,
} from "./lifecycle.js";
import type {
  GoldenChangedFile,
  GoldenIllegalLifecycleScenario,
  GoldenIsolationScenario,
  GoldenLifecycleScenario,
  GoldenMalformedLifecycleScenario,
} from "./lifecycle-golden-types.js";

type LifecycleReplayState = ReturnType<typeof replayLifecycleEvents>;

const terminalRunAttemptStatuses = new Set<RunAttemptStatus>([
  "succeeded",
  "interrupted",
  "failed",
]);
const terminalItemStatuses = new Set<ItemStatus>([
  "completed",
  "failed",
  "declined",
  "interrupted",
]);
const terminalToolCallStatuses = new Set<ToolCallStatus>([
  "completed",
  "failed",
  "declined",
  "interrupted",
]);
const terminalApprovalStatuses = new Set<ApprovalStatus>([
  "approved",
  "denied",
  "cancelled",
]);

export async function expectGoldenScenarioConformance(
  log: LifecycleEventLogContract,
  scenario: GoldenLifecycleScenario,
): Promise<void> {
  await log.appendBatch(scenario.events);
  const fullReplay = await log.replay({ afterSequence: null, limit: 1_000 });
  const liveState = replayLifecycleEvents(scenario.events);
  const replayState = replayLifecycleEvents(fullReplay.events);

  expect(fullReplay.events).toEqual(scenario.events);
  expect(replayState).toEqual(liveState);
  expect(replayState.terminalEvents).toBe(1);
  expect(replayState.terminalOutcome?.status).toBe(scenario.terminalStatus);
  expect(collectChangedFiles(fullReplay.events)).toEqual(scenario.changedFiles);
  expectNoActiveState(replayState);

  await expectCursorReplayConformance(log, scenario, liveState);
  await expectReloadAfterCompletionConformance(log, scenario);
}

export function expectIllegalScenarioRejection(
  scenario: GoldenIllegalLifecycleScenario,
): void {
  expect(() => replayLifecycleEvents(scenario.events)).toThrow(
    LifecycleTransitionError,
  );
}

export function expectMalformedScenarioRejection(
  scenario: GoldenMalformedLifecycleScenario,
): void {
  expect(() => LifecycleEventSchema.parse(scenario.event)).toThrow();
}

export function expectIsolationConformance(
  scenario: GoldenIsolationScenario,
): void {
  const leftState = replayLifecycleEvents(scenario.left.events);
  const rightState = replayLifecycleEvents(scenario.right.events);

  expect(leftState.turnId).not.toBe(rightState.turnId);
  expect(collectChangedFiles(scenario.left.events)).toEqual(
    scenario.left.changedFiles,
  );
  expect(collectChangedFiles(scenario.right.events)).toEqual(
    scenario.right.changedFiles,
  );
  expect(() => replayLifecycleEvents(scenario.mixedEvents)).toThrow(
    LifecycleTransitionError,
  );
}

function expectNoActiveState(state: LifecycleReplayState): void {
  expect(Object.values(state.runAttempts).every(isTerminalRunAttempt)).toBe(true);
  expect(Object.values(state.items).every(isTerminalItem)).toBe(true);
  expect(Object.values(state.toolCalls).every(isTerminalToolCall)).toBe(true);
  expect(Object.values(state.approvals).every(isTerminalApproval)).toBe(true);
}

async function expectCursorReplayConformance(
  log: LifecycleEventLogContract,
  scenario: GoldenLifecycleScenario,
  liveState: LifecycleReplayState,
): Promise<void> {
  for (const cursor of scenario.cursors) {
    const replay = await log.replay({ afterSequence: cursor, limit: 1_000 });
    const recomposed = scenario.events.slice(0, cursor).concat(replay.events);
    expect(replayLifecycleEvents(recomposed)).toEqual(liveState);
  }
}

async function expectReloadAfterCompletionConformance(
  log: LifecycleEventLogContract,
  scenario: GoldenLifecycleScenario,
): Promise<void> {
  if (!scenario.reloadAfterCompletion) {
    return;
  }
  const lastSequence = scenario.events.at(-1)?.sequence ?? null;
  const replay = await log.replay({ afterSequence: lastSequence, limit: 1_000 });
  expect(replay.events).toEqual([]);
}

function collectChangedFiles(
  events: readonly LifecycleEvent[],
): readonly GoldenChangedFile[] {
  return events
    .filter((event) => event.type === "turn.diff_updated")
    .flatMap((event) => readChangedFiles(event.payload));
}

function readChangedFiles(payload: Record<string, unknown>): GoldenChangedFile[] {
  const files = payload.files;
  if (!Array.isArray(files)) {
    return [];
  }
  return files.filter(isGoldenChangedFile);
}

function isGoldenChangedFile(value: unknown): value is GoldenChangedFile {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.path === "string" &&
    isGoldenChangedFileStatus(value.status)
  );
}

function isGoldenChangedFileStatus(
  status: unknown,
): status is GoldenChangedFile["status"] {
  return status === "created" || status === "modified" || status === "deleted";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTerminalRunAttempt(status: RunAttemptStatus): boolean {
  return terminalRunAttemptStatuses.has(status);
}

function isTerminalItem(status: ItemStatus): boolean {
  return terminalItemStatuses.has(status);
}

function isTerminalToolCall(status: ToolCallStatus): boolean {
  return terminalToolCallStatuses.has(status);
}

function isTerminalApproval(status: ApprovalStatus): boolean {
  return terminalApprovalStatuses.has(status);
}
