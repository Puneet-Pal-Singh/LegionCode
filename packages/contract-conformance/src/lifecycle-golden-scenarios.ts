import type { LifecycleEvent } from "@repo/platform-protocol/lifecycle";
import {
  approvalId,
  createGoldenContext,
  event,
  itemCompleted,
  itemDeclined,
  itemFailed,
  itemId,
  itemInterrupted,
  itemStarted,
  protocolFailure,
  runAttemptId,
  terminalEvent,
  toolCallId,
  toolEvent,
  turnDiffUpdated,
} from "./lifecycle-golden-events.js";
import type {
  GoldenChangedFile,
  GoldenIsolationScenario,
  GoldenLifecycleMatrix,
  GoldenLifecycleScenario,
} from "./lifecycle-golden-types.js";

export function createGoldenLifecycleMatrix(): GoldenLifecycleMatrix {
  const legal = createLegalScenarios();
  const isolation = createIsolationScenario(legal);
  return {
    legal,
    isolation,
    illegal: [
      { name: "malformed/illegal event rejection", events: activeItemTerminalEvents() },
    ],
    malformed: [{ name: "malformed event schema rejection", event: malformedEvent() }],
  };
}

function createLegalScenarios(): readonly GoldenLifecycleScenario[] {
  return [
    reasoningFinalScenario(),
    toolEditsScenario(),
    approvalApprovedScenario(),
    approvalDeniedScenario(),
    reasoningInterruptScenario(),
    toolInterruptScenario(),
    toolFailurePartialEditsScenario(),
    providerRetryScenario(),
    restartBeforeSettlementScenario(),
    reconnectActiveTurnScenario(),
    reloadAfterCompletionScenario(),
    replayCursorScenario(),
    zeroChangeCompletionScenario(),
  ];
}

function reasoningFinalScenario(): GoldenLifecycleScenario {
  const context = createGoldenContext("goldpromptfinal");
  const reasoning = itemId(context, "reason");
  const message = itemId(context, "message");
  return scenario("prompt -> reasoning -> final message -> completed", [
    event(context, 1, "turn.queued"),
    event(context, 2, "turn.started"),
    event(context, 3, "run_attempt.started"),
    itemStarted(context, 4, reasoning, "reasoning"),
    event(context, 5, "reasoning.summary_delta", { text: "Thinking." }, { itemId: reasoning }),
    itemCompleted(context, 6, reasoning),
    itemStarted(context, 7, message, "assistant_message"),
    event(context, 8, "assistant_message.delta", { text: "Done." }, { itemId: message }),
    itemCompleted(context, 9, message),
    event(context, 10, "run_attempt.succeeded"),
    terminalEvent(context, 11, "turn.completed", { status: "completed" }),
  ]);
}

function toolEditsScenario(): GoldenLifecycleScenario {
  const context = createGoldenContext("goldtooledits");
  const plan = itemId(context, "plan01");
  const tool = itemId(context, "tool01");
  const file = itemId(context, "file01");
  const call = toolCallId(context, "shell1");
  const files = changedFiles(["apps/api.ts", "packages/protocol.ts"]);
  return scenario("prompt -> plan -> tool calls -> edits -> multi-file turn diff -> completed", [
    event(context, 1, "turn.queued"),
    event(context, 2, "turn.started"),
    event(context, 3, "run_attempt.started"),
    itemStarted(context, 4, plan, "plan"),
    event(context, 5, "plan.updated", { text: "Edit two files." }, { itemId: plan }),
    itemCompleted(context, 6, plan),
    itemStarted(context, 7, tool, "tool_call"),
    toolEvent(context, 8, "tool_call.started", tool, call, { toolName: "shell" }),
    toolEvent(context, 9, "tool_call.input_delta", tool, call, { input: "apply patch" }),
    toolEvent(context, 10, "tool_call.completed", tool, call, { result: {} }),
    itemCompleted(context, 11, tool),
    itemStarted(context, 12, file, "file_change"),
    event(context, 13, "file_change.patch_updated", { files }, { itemId: file }),
    itemCompleted(context, 14, file),
    turnDiffUpdated(context, 15, files),
    event(context, 16, "run_attempt.succeeded"),
    terminalEvent(context, 17, "turn.completed", { status: "completed" }),
  ], files);
}

function approvalApprovedScenario(): GoldenLifecycleScenario {
  const context = createGoldenContext("goldapprapprove");
  const approval = itemId(context, "approval");
  const approvalRef = approvalId(context, "shell1");
  return scenario("approval request -> wait -> approve -> continue -> completed", [
    event(context, 1, "turn.queued"),
    event(context, 2, "turn.started"),
    event(context, 3, "run_attempt.started"),
    itemStarted(context, 4, approval, "approval_request"),
    event(context, 5, "approval.requested", { reason: "Run command." }, { itemId: approval, approvalId: approvalRef }),
    event(context, 6, "turn.blocking_changed", { blockingState: { kind: "waiting_for_approval", itemId: approval, approvalId: approvalRef } }),
    event(context, 7, "approval.decided", { status: "approved" }, { itemId: approval, approvalId: approvalRef }),
    event(context, 8, "turn.blocking_changed", { blockingState: { kind: "none" } }),
    itemCompleted(context, 9, approval),
    event(context, 10, "run_attempt.succeeded"),
    terminalEvent(context, 11, "turn.completed", { status: "completed" }),
  ]);
}

function approvalDeniedScenario(): GoldenLifecycleScenario {
  const context = createGoldenContext("goldapprdenied");
  const approval = itemId(context, "approval");
  const approvalRef = approvalId(context, "shell1");
  return scenario("approval request -> deny -> explicit item/turn result", [
    event(context, 1, "turn.queued"),
    event(context, 2, "turn.started"),
    event(context, 3, "run_attempt.started"),
    itemStarted(context, 4, approval, "approval_request"),
    event(context, 5, "approval.requested", { reason: "Run command." }, { itemId: approval, approvalId: approvalRef }),
    event(context, 6, "turn.blocking_changed", { blockingState: { kind: "waiting_for_approval", itemId: approval, approvalId: approvalRef } }),
    event(context, 7, "approval.decided", { status: "denied" }, { itemId: approval, approvalId: approvalRef }),
    event(context, 8, "turn.blocking_changed", { blockingState: { kind: "none" } }),
    itemDeclined(context, 9, approval, "User denied approval."),
    event(context, 10, "run_attempt.succeeded"),
    terminalEvent(context, 11, "turn.completed", { status: "completed" }),
  ]);
}

function reasoningInterruptScenario(): GoldenLifecycleScenario {
  const context = createGoldenContext("goldreasonstop");
  const reasoning = itemId(context, "reason");
  return scenario("interrupt during reasoning", [
    event(context, 1, "turn.queued"),
    event(context, 2, "turn.started"),
    event(context, 3, "run_attempt.started"),
    itemStarted(context, 4, reasoning, "reasoning"),
    event(context, 5, "reasoning.summary_delta", { text: "Working." }, { itemId: reasoning }),
    itemInterrupted(context, 6, reasoning, "User interrupted reasoning."),
    event(context, 7, "run_attempt.interrupted"),
    terminalEvent(context, 8, "turn.interrupted", { status: "interrupted", reason: "User interrupted reasoning." }),
  ], [], "interrupted");
}

function toolInterruptScenario(): GoldenLifecycleScenario {
  const context = createGoldenContext("goldtoolstop");
  const tool = itemId(context, "tool01");
  const call = toolCallId(context, "shell1");
  return scenario("interrupt during tool execution", [
    event(context, 1, "turn.queued"),
    event(context, 2, "turn.started"),
    event(context, 3, "run_attempt.started"),
    itemStarted(context, 4, tool, "tool_call"),
    toolEvent(context, 5, "tool_call.started", tool, call, { toolName: "shell" }),
    toolEvent(context, 6, "tool_call.interrupted", tool, call, { reason: "User interrupted tool." }),
    itemInterrupted(context, 7, tool, "User interrupted tool."),
    event(context, 8, "run_attempt.interrupted"),
    terminalEvent(context, 9, "turn.interrupted", { status: "interrupted", reason: "User interrupted tool." }),
  ], [], "interrupted");
}

function toolFailurePartialEditsScenario(): GoldenLifecycleScenario {
  const context = createGoldenContext("goldtoolfail");
  const tool = itemId(context, "tool01");
  const call = toolCallId(context, "shell1");
  const files = changedFiles(["src/partial.ts"]);
  const failure = protocolFailure("Tool failed after partial edits.");
  return scenario("tool failure after partial edits", [
    event(context, 1, "turn.queued"),
    event(context, 2, "turn.started"),
    event(context, 3, "run_attempt.started"),
    itemStarted(context, 4, tool, "tool_call"),
    toolEvent(context, 5, "tool_call.started", tool, call, { toolName: "shell" }),
    turnDiffUpdated(context, 6, files),
    toolEvent(context, 7, "tool_call.failed", tool, call, { failure }),
    itemFailed(context, 8, tool, failure),
    event(context, 9, "run_attempt.failed"),
    terminalEvent(context, 10, "turn.failed", { status: "failed", failure }),
  ], files, "failed");
}

function providerRetryScenario(): GoldenLifecycleScenario {
  const context = createGoldenContext("goldretryflow");
  const firstAttempt = context.runAttemptId;
  const secondAttempt = runAttemptId(context.slug, "retry02");
  const failedReasoning = itemId(context, "reason");
  const message = itemId(context, "message");
  const failure = protocolFailure("Provider stream disconnected.");
  return scenario("provider stream disconnect and retry", [
    event(context, 1, "turn.queued"),
    event(context, 2, "turn.started"),
    event(context, 3, "run_attempt.started", {}, { runAttemptId: firstAttempt }),
    itemStarted(context, 4, failedReasoning, "reasoning", { runAttemptId: firstAttempt }),
    itemFailed(context, 5, failedReasoning, failure, { runAttemptId: firstAttempt }),
    event(context, 6, "run_attempt.failed", {}, { runAttemptId: firstAttempt }),
    event(context, 7, "turn.blocking_changed", { blockingState: { kind: "retry_scheduled", runAttemptId: secondAttempt } }),
    event(context, 8, "turn.blocking_changed", { blockingState: { kind: "none" } }),
    event(context, 9, "run_attempt.started", {}, { runAttemptId: secondAttempt }),
    itemStarted(context, 10, message, "assistant_message", { runAttemptId: secondAttempt }),
    event(context, 11, "assistant_message.delta", { text: "Recovered." }, { itemId: message, runAttemptId: secondAttempt }),
    itemCompleted(context, 12, message, { runAttemptId: secondAttempt }),
    event(context, 13, "run_attempt.succeeded", {}, { runAttemptId: secondAttempt }),
    terminalEvent(context, 14, "turn.completed", { status: "completed" }, { runAttemptId: secondAttempt }),
  ]);
}

function restartBeforeSettlementScenario(): GoldenLifecycleScenario {
  const context = createGoldenContext("goldrestart");
  const message = itemId(context, "message");
  return scenario("runtime restart before settlement", [
    event(context, 1, "turn.queued"),
    event(context, 2, "turn.started"),
    event(context, 3, "run_attempt.started"),
    itemStarted(context, 4, message, "assistant_message"),
    event(context, 5, "workspace.state_changed", { reason: "runtime_restart" }),
    event(context, 6, "assistant_message.delta", { text: "Restored." }, { itemId: message }),
    itemCompleted(context, 7, message),
    event(context, 8, "run_attempt.succeeded"),
    terminalEvent(context, 9, "turn.completed", { status: "completed" }),
  ]);
}

function reconnectActiveTurnScenario(): GoldenLifecycleScenario {
  const context = createGoldenContext("goldreconnect");
  const message = itemId(context, "message");
  return scenario("reconnect during active turn", [
    event(context, 1, "turn.queued"),
    event(context, 2, "turn.started"),
    event(context, 3, "run_attempt.started"),
    itemStarted(context, 4, message, "assistant_message"),
    event(context, 5, "assistant_message.delta", { text: "Still active." }, { itemId: message }),
    itemCompleted(context, 6, message),
    event(context, 7, "run_attempt.succeeded"),
    terminalEvent(context, 8, "turn.completed", { status: "completed" }),
  ]);
}

function reloadAfterCompletionScenario(): GoldenLifecycleScenario {
  const context = createGoldenContext("goldreload");
  return {
    ...scenario("reload after completion", [
      event(context, 1, "turn.queued"),
      event(context, 2, "turn.started"),
      event(context, 3, "run_attempt.started"),
      event(context, 4, "run_attempt.succeeded"),
      terminalEvent(context, 5, "turn.completed", { status: "completed" }),
    ]),
    reloadAfterCompletion: true,
  };
}

function replayCursorScenario(): GoldenLifecycleScenario {
  const context = createGoldenContext("goldreplay");
  const message = itemId(context, "message");
  return scenario("replay from event zero and from intermediate cursor", [
    event(context, 1, "turn.queued"),
    event(context, 2, "turn.started"),
    event(context, 3, "run_attempt.started"),
    itemStarted(context, 4, message, "assistant_message"),
    event(context, 5, "assistant_message.delta", { text: "Replay me." }, { itemId: message }),
    itemCompleted(context, 6, message),
    event(context, 7, "run_attempt.succeeded"),
    terminalEvent(context, 8, "turn.completed", { status: "completed" }),
  ]);
}

function zeroChangeCompletionScenario(): GoldenLifecycleScenario {
  const context = createGoldenContext("goldzerochange");
  return scenario("zero-change completion", [
    event(context, 1, "turn.queued"),
    event(context, 2, "turn.started"),
    event(context, 3, "run_attempt.started"),
    event(context, 4, "run_attempt.succeeded"),
    terminalEvent(context, 5, "turn.completed", { status: "completed" }),
  ]);
}

function activeItemTerminalEvents(): readonly LifecycleEvent[] {
  const context = createGoldenContext("goldillegal");
  const message = itemId(context, "message");
  return [
    event(context, 1, "turn.queued"),
    event(context, 2, "turn.started"),
    event(context, 3, "run_attempt.started"),
    itemStarted(context, 4, message, "assistant_message"),
    event(context, 5, "run_attempt.succeeded"),
    terminalEvent(context, 6, "turn.completed", { status: "completed" }),
  ];
}

function createIsolationScenario(
  scenarios: readonly GoldenLifecycleScenario[],
): GoldenIsolationScenario {
  const left = requiredScenario(scenarios, 0);
  const right = requiredScenario(scenarios, 1);
  return {
    name: "isolation between simultaneous turns/workspaces",
    left,
    right,
    mixedEvents: [requiredEvent(left.events, 0), requiredEvent(right.events, 1)],
  };
}

function scenario(
  name: string,
  events: readonly LifecycleEvent[],
  changedFiles: readonly GoldenChangedFile[] = [],
  terminalStatus: "completed" | "interrupted" | "failed" = "completed",
): GoldenLifecycleScenario {
  return {
    name,
    events,
    changedFiles,
    terminalStatus,
    cursors: [Math.max(1, Math.floor(events.length / 2))],
  };
}

function changedFiles(paths: readonly string[]): readonly GoldenChangedFile[] {
  return paths.map((path): GoldenChangedFile => ({ path, status: "modified" }));
}

function malformedEvent(): unknown {
  return {
    type: "turn.completed",
    payload: { outcome: { status: "completed" } },
  };
}

function requiredScenario(
  scenarios: readonly GoldenLifecycleScenario[],
  index: number,
): GoldenLifecycleScenario {
  const scenario = scenarios[index];
  if (!scenario) {
    throw new Error(`Missing golden lifecycle scenario at index ${index}`);
  }
  return scenario;
}

function requiredEvent(
  events: readonly LifecycleEvent[],
  index: number,
): LifecycleEvent {
  const event = events[index];
  if (!event) {
    throw new Error(`Missing golden lifecycle event at index ${index}`);
  }
  return event;
}
