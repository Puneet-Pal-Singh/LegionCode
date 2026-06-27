import type { CoreMessage, CoreTool } from "ai";
import type { EditToolActivityMetadata } from "@repo/shared-types";
import type { Run } from "../run/index.js";
import type { AgenticLoopResult } from "./AgenticLoop.js";
import type {
  AgenticLoopTerminalLlmIssue,
  AgenticLoopToolLifecycleEvent,
} from "../types.js";
import {
  enforceGoldenFlowToolFloor,
  getGoldenFlowToolRegistry,
} from "../contracts/CodingToolGateway.js";

const AGENTIC_LOOP_DEFAULT_MAX_STEPS = 25;
export const TASK_MODEL_NO_ACTION_CODE = "TASK_MODEL_NO_ACTION";
const TOOL_EXECUTION_FAILED_CODE = "TOOL_EXECUTION_FAILED";
const LEAKED_INTERNAL_PREFACE_PATTERNS = [
  /^the user (said|asked|requested|wants)\b/i,
  /^this is (?:a|an)\b/i,
  /^i should (?:check|inspect|review|find|get|start|respond|ask|run|switch|use|continue|determine|verify|summarize|fix|implement)\b/i,
  /^i need to (?:check|inspect|review|find|get|start|respond|ask|run|switch|use|continue|determine|verify|summarize|fix|implement)\b/i,
  /^first,?\s+i(?:'ll| will| need to)\b/i,
  /^(?:the )?current branch is\b/i,
  /^usually,\s*prs?\b/i,
  /^wait[,!\s]/i,
];

export interface AssistantTurnOutput {
  text: string;
  metadata?: Record<string, unknown>;
}

export function resolveAgenticLoopTools(
  metadata: Record<string, unknown> | undefined,
  incomingTools: Record<string, CoreTool>,
): Record<string, CoreTool> | null {
  if (!isAgenticLoopEnabled(metadata)) {
    return null;
  }

  return enforceGoldenFlowToolFloor(
    { ...getGoldenFlowToolRegistry(), ...incomingTools },
    metadata,
  );
}

export function getAgenticLoopMaxSteps(
  metadata?: Record<string, unknown>,
): number {
  const featureFlags = metadata?.featureFlags;
  if (typeof featureFlags !== "object" || featureFlags === null) {
    return AGENTIC_LOOP_DEFAULT_MAX_STEPS;
  }

  const raw = (featureFlags as Record<string, unknown>).agenticLoopMaxSteps;
  if (
    typeof raw === "number" &&
    Number.isInteger(raw) &&
    raw > 0 &&
    raw <= 128
  ) {
    return raw;
  }

  return AGENTIC_LOOP_DEFAULT_MAX_STEPS;
}

export function recordAgenticLoopMetadata(
  run: Run,
  result: AgenticLoopResult,
): void {
  run.metadata.agenticLoop = {
    enabled: true,
    stopReason: result.stopReason,
    stepsExecuted: result.stepsExecuted,
    toolExecutionCount: result.toolExecutionCount,
    failedToolCount: result.failedToolCount,
    requiresMutation: result.requiresMutation,
    currentTurnIntent: result.currentTurnIntent,
    completedMutatingToolCount: result.completedMutatingToolCount,
    completedReadOnlyToolCount: result.completedReadOnlyToolCount,
    recoveryCode: deriveAgenticLoopRecoveryCode(result),
    llmRetryCount: result.llmRetryCount ?? 0,
    terminalLlmIssue: result.terminalLlmIssue,
    toolLifecycle: result.toolLifecycle,
    completedAt: new Date().toISOString(),
  };
}

export function recordRecoveredAgenticLoopMetadata(
  run: Run,
  input: {
    stopReason: AgenticLoopResult["stopReason"];
    stepsExecuted: number;
    toolExecutionCount: number;
    failedToolCount: number;
    requiresMutation: boolean;
    currentTurnIntent?: AgenticLoopResult["currentTurnIntent"];
    completedMutatingToolCount: number;
    completedReadOnlyToolCount: number;
    llmRetryCount: number;
    toolLifecycle: AgenticLoopToolLifecycleEvent[];
    recoveryCode?: typeof TASK_MODEL_NO_ACTION_CODE;
    terminalLlmIssue?: AgenticLoopTerminalLlmIssue;
  },
): void {
  run.metadata.agenticLoop = {
    enabled: true,
    stopReason: input.stopReason,
    stepsExecuted: input.stepsExecuted,
    toolExecutionCount: input.toolExecutionCount,
    failedToolCount: input.failedToolCount,
    requiresMutation: input.requiresMutation,
    currentTurnIntent: input.currentTurnIntent,
    completedMutatingToolCount: input.completedMutatingToolCount,
    completedReadOnlyToolCount: input.completedReadOnlyToolCount,
    recoveryCode: input.recoveryCode,
    llmRetryCount: input.llmRetryCount,
    terminalLlmIssue: input.terminalLlmIssue,
    toolLifecycle: input.toolLifecycle,
    completedAt: new Date().toISOString(),
  };
}

export function buildAgenticLoopFinalOutput(result: AgenticLoopResult): string {
  return buildAgenticLoopFinalMessage(result).text;
}

export function buildAgenticLoopFinalMessage(
  result: AgenticLoopResult,
): AssistantTurnOutput {
  const mutationScopedTurn = isMutationScopedTurn(result);
  const assistantText = getLastAssistantText(result.messages);

  if (mutationScopedTurn && result.completedMutatingToolCount > 0) {
    const groundedMutationSummary = buildCompletedMutationSummary(result);
    if (groundedMutationSummary) {
      if (result.stopReason === "tool_error") {
        return {
          text: groundedMutationSummary,
          metadata: buildToolExecutionFailedMetadata(result.toolLifecycle),
        };
      }
      return { text: groundedMutationSummary };
    }
  }

  if (result.stopReason === "tool_error") {
    return {
      text: buildFallbackLoopSummary(result),
      metadata: buildToolExecutionFailedMetadata(result.toolLifecycle),
    };
  }

  if (result.stopReason !== "llm_stop") {
    return { text: buildFallbackLoopSummary(result) };
  }

  if (
    mutationScopedTurn &&
    result.completedMutatingToolCount === 0 &&
    shouldPreserveNoMutationAssistantText(assistantText)
  ) {
    return { text: assistantText! };
  }

  if (mutationScopedTurn && result.completedMutatingToolCount === 0) {
    return { text: buildNoMutationEvidenceSummary(result) };
  }

  if (assistantText) {
    return { text: assistantText };
  }

  return {
    text: buildMissingAssistantSynthesisSummary(result),
    metadata: buildTaskModelNoActionMetadata(),
  };
}

export function buildTaskModelNoActionSummary(input: {
  requiresMutation: boolean;
  toolLifecycle: AgenticLoopToolLifecycleEvent[];
}): string {
  const lines = [
    input.requiresMutation
      ? "The model did not return a usable next action for this edit request."
      : "The model did not return a usable response for this run.",
  ];

  if (input.requiresMutation) {
    lines.push("No file was changed in this run.");
  }

  const completedTools = getLatestToolLifecycle(
    input.toolLifecycle,
    "completed",
  );
  const failedTools = getLatestToolLifecycle(input.toolLifecycle, "failed");

  if (completedTools.length > 0) {
    lines.push(describeCompletedToolWork(completedTools));
  }

  if (failedTools.length > 0) {
    lines.push(describeFailedToolWork(failedTools));
  }

  lines.push(
    "Retry the task. If this keeps happening, switch to a faster or more reliable model.",
  );

  return lines.join("\n");
}

function buildNoMutationEvidenceSummary(result: AgenticLoopResult): string {
  const completedTools = getLatestToolLifecycle(
    result.toolLifecycle,
    "completed",
  );
  const failedTools = getLatestToolLifecycle(result.toolLifecycle, "failed");

  const lines = ["No files were changed in this run."];

  if (completedTools.length > 0) {
    lines.push(describeCompletedToolWork(completedTools));
  }

  if (failedTools.length > 0) {
    lines.push(describeFailedToolWork(failedTools));
  }

  return lines.join("\n");
}

function buildFallbackLoopSummary(result: AgenticLoopResult): string {
  const completedTools = getLatestToolLifecycle(
    result.toolLifecycle,
    "completed",
  );
  const failedTools = getLatestToolLifecycle(result.toolLifecycle, "failed");
  const lines = [describeLoopStopReason(result.stopReason)];

  if (completedTools.length > 0) {
    lines.push(describeCompletedToolWork(completedTools));
  }

  if (failedTools.length > 0) {
    lines.push(describeFailedToolWork(failedTools));
  }

  lines.push(getFallbackRetryHint(result.stopReason));

  return lines.join("\n");
}

function buildMissingAssistantSynthesisSummary(
  result: AgenticLoopResult,
): string {
  const completedTools = getLatestToolLifecycle(
    result.toolLifecycle,
    "completed",
  );
  const failedTools = getLatestToolLifecycle(result.toolLifecycle, "failed");
  const lines = [
    "I completed the tool loop, but I could not produce a final assistant answer for this run.",
  ];

  if (completedTools.length > 0) {
    lines.push(describeCompletedToolWork(completedTools));
  }

  if (failedTools.length > 0) {
    lines.push(describeFailedToolWork(failedTools));
  }

  lines.push(
    "Retry the task. If this keeps happening, switch to a faster or more reliable model.",
  );
  return lines.join("\n");
}

function getFallbackRetryHint(
  stopReason: AgenticLoopResult["stopReason"],
): string {
  switch (stopReason) {
    case "tool_error":
      return "Retry the request after fixing the failed step.";
    case "budget_exceeded":
      return "Retry with a higher budget or simplify the request so fewer costly steps are needed.";
    case "max_steps_reached":
      return "Retry with a narrower prompt or increase max steps so the run can finish.";
    case "cancelled":
      return "Retry by resubmitting the request and keeping the run active until it completes.";
    default:
      return "Retry the request.";
  }
}

function buildCompletedMutationSummary(
  result: AgenticLoopResult,
): string | null {
  const editEvents = collectCompletedEditEvents(result.toolLifecycle);
  if (editEvents.length === 0) {
    return null;
  }

  const changes = mergeEditEvents(editEvents);
  const changedFilesLabel =
    changes.length === 1
      ? "I completed the requested update and changed this file:"
      : `I completed the requested update and changed ${changes.length} files:`;

  const updatedTargets = deriveUpdatedTargets(
    changes.map((change) => change.filePath),
  );
  const lines = [
    changedFilesLabel,
    ...changes.map(
      (change) =>
        `- ${change.filePath} (+${change.additions} -${change.deletions})`,
    ),
  ];

  if (updatedTargets.length > 0) {
    lines.push(`Updated sections/components: ${updatedTargets.join(", ")}`);
  }

  const failedTools = getLatestToolLifecycle(result.toolLifecycle, "failed");
  if (failedTools.length > 0) {
    lines.push(describeFailedToolWork(failedTools));
  }

  return lines.join("\n");
}

function isAgenticLoopEnabled(metadata?: Record<string, unknown>): boolean {
  if (!metadata) {
    return false;
  }

  const directFlag = metadata.agenticLoopV1;
  if (typeof directFlag === "boolean") {
    return directFlag;
  }

  const featureFlags = metadata.featureFlags;
  if (typeof featureFlags !== "object" || featureFlags === null) {
    return false;
  }

  const nestedFlag = (featureFlags as Record<string, unknown>).agenticLoopV1;
  return typeof nestedFlag === "boolean" ? nestedFlag : false;
}

function getLastAssistantText(messages: CoreMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || message.role !== "assistant") {
      continue;
    }
    const textContent = extractTextContent(message.content);
    if (textContent) {
      return textContent;
    }
  }

  return null;
}

function extractTextContent(content: CoreMessage["content"]): string | null {
  if (typeof content === "string") {
    const normalized = sanitizeAssistantSummaryText(content).trim();
    return normalized ? normalized : null;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const text = content
    .filter(
      (
        part,
      ): part is {
        type: "text";
        text: string;
      } => part.type === "text" && typeof part.text === "string",
    )
    .map((part) => normalizeStandaloneToolCallMarkup(part.text).trim())
    .filter(Boolean)
    .join("\n");
  const normalized = sanitizeAssistantSummaryText(text).trim();
  return normalized || null;
}

function normalizeStandaloneToolCallMarkup(text: string): string {
  const trimmed = text.trim();
  if (/^<tool_call>[\s\S]*<\/tool_call>$/i.test(trimmed)) {
    return "";
  }

  return text;
}

function sanitizeAssistantSummaryText(text: string): string {
  const normalized = normalizeStandaloneToolCallMarkup(text);
  if (!normalized.trim()) {
    return "";
  }

  return stripLeakedInternalPreface(normalized);
}

function stripLeakedInternalPreface(text: string): string {
  let remaining = text.trim();
  let removedAny = false;

  while (remaining.length > 0) {
    const sentence = readLeadingSentence(remaining);
    if (!sentence) {
      break;
    }
    if (!isLeakedInternalPrefaceSentence(sentence.value)) {
      break;
    }

    removedAny = true;
    remaining = sentence.rest.trimStart();
  }

  return removedAny ? remaining : text;
}

function readLeadingSentence(
  text: string,
): { value: string; rest: string } | null {
  const trimmed = text.trimStart();
  if (!trimmed) {
    return null;
  }

  const match = trimmed.match(
    /^([\s\S]*?[.!?])(?:[\s"'`)\]]+|(?=[A-Z0-9]))([\s\S]*)$/,
  );
  if (!match) {
    return { value: trimmed, rest: "" };
  }

  return {
    value: (match[1] ?? "").trim(),
    rest: match[2] ?? "",
  };
}

function isLeakedInternalPrefaceSentence(sentence: string): boolean {
  const normalized = sentence.trim();
  if (!normalized) {
    return false;
  }

  return LEAKED_INTERNAL_PREFACE_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
}

function describeLoopStopReason(
  stopReason: AgenticLoopResult["stopReason"],
): string {
  switch (stopReason) {
    case "tool_error":
      return "I stopped because a required tool action failed.";
    case "budget_exceeded":
      return "I stopped because the run hit the execution budget.";
    case "max_steps_reached":
      return "I ran out of tool steps before I could finish the request.";
    case "cancelled":
      return "The run was cancelled before I could finish the answer.";
    case "llm_stop":
      return "The build loop completed.";
  }
}

export function buildTaskModelNoActionMetadata(): Record<string, unknown> {
  return {
    code: TASK_MODEL_NO_ACTION_CODE,
    retryable: true,
    resumeHint: "Retry the task or switch to a faster or more reliable model.",
    resumeActions: ["retry", "switch_model"],
  };
}

function buildToolExecutionFailedMetadata(
  toolLifecycle: AgenticLoopToolLifecycleEvent[],
): Record<string, unknown> {
  const failedTools = getLatestToolLifecycle(toolLifecycle, "failed");
  const primaryFailure = getTerminalToolLifecycleEvent(failedTools);

  return {
    code: TOOL_EXECUTION_FAILED_CODE,
    retryable: true,
    resumeHint: deriveToolFailureResumeHint(primaryFailure),
    resumeActions: ["retry", "open_terminal"],
  };
}

function deriveAgenticLoopRecoveryCode(
  result: AgenticLoopResult,
): typeof TASK_MODEL_NO_ACTION_CODE | undefined {
  if (
    result.stopReason === "llm_stop" &&
    !getLastAssistantText(result.messages)
  ) {
    return TASK_MODEL_NO_ACTION_CODE;
  }

  return undefined;
}

function isMutationScopedTurn(result: AgenticLoopResult): boolean {
  if (result.currentTurnIntent) {
    return result.currentTurnIntent !== "read_only";
  }

  return result.requiresMutation;
}

function shouldPreserveAssistantText(text: string | null): boolean {
  if (!text) {
    return false;
  }

  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (normalized.includes("?")) {
    return true;
  }

  const clarificationSignals = [
    "please clarify",
    "please provide",
    "could you clarify",
    "which file",
    "which component",
    "which path",
    "what file",
    "what component",
    "what path",
    "do you want",
    "i need",
    "need the exact",
    "need more context",
  ];
  if (clarificationSignals.some((signal) => normalized.includes(signal))) {
    return true;
  }

  const refusalSignals = [
    "i can't",
    "i cannot",
    "unable to",
    "won't",
    "not able to",
    "permission",
    "refuse",
    "policy",
    "not allowed",
  ];
  return refusalSignals.some((signal) => normalized.includes(signal));
}

function shouldPreserveNoMutationAssistantText(text: string | null): boolean {
  if (!text) {
    return false;
  }

  if (shouldPreserveAssistantText(text)) {
    return true;
  }

  const normalized = text.trim().toLowerCase();
  const explicitBlockerSignals = [
    "approval",
    "authorization",
    "cannot continue",
    "can't continue",
    "could not continue",
    "must approve",
    "scope decision",
    "still need",
    "need file mutation evidence",
    "blocked",
  ];

  return explicitBlockerSignals.some((signal) => normalized.includes(signal));
}

function getLatestToolLifecycle(
  toolLifecycle: AgenticLoopToolLifecycleEvent[],
  status: AgenticLoopToolLifecycleEvent["status"],
): AgenticLoopToolLifecycleEvent[] {
  const latestByToolCall = new Map<string, AgenticLoopToolLifecycleEvent>();
  for (const event of toolLifecycle) {
    latestByToolCall.set(event.toolCallId, event);
  }

  return [...latestByToolCall.values()].filter(
    (event) => event.status === status,
  );
}

function describeCompletedToolWork(
  completedTools: AgenticLoopToolLifecycleEvent[],
): string {
  const editEvents = collectCompletedEditEvents(completedTools);
  if (editEvents.length > 0) {
    const changes = mergeEditEvents(editEvents);
    const files = changes.map((change) => change.filePath).join(", ");
    return `Before the run stopped, I successfully updated ${changes.length} file(s): ${files}.`;
  }

  const completedGitMutations = completedTools.filter((event) =>
    isMutationFocusedGitTool(event.toolName),
  );
  if (completedGitMutations.length > 0) {
    return `Before the run stopped, I completed ${completedGitMutations.length} repository step(s) that changed branch or commit state.`;
  }

  return `Before the run stopped, I completed ${completedTools.length} inspection step(s) to gather workspace evidence.`;
}

function describeFailedToolWork(
  failedTools: AgenticLoopToolLifecycleEvent[],
): string {
  const primaryFailure = getTerminalToolLifecycleEvent(failedTools);
  if (!primaryFailure) {
    return "The run recorded a tool failure.";
  }

  const primarySummary = describeSingleFailedTool(primaryFailure);
  if (failedTools.length === 1) {
    return primarySummary;
  }

  return `${primarySummary} There were ${failedTools.length - 1} additional failed tool action(s) in the same run.`;
}

function describeSingleFailedTool(
  event: AgenticLoopToolLifecycleEvent,
): string {
  const missingShellPath = extractMissingShellPath(event);
  if (missingShellPath) {
    return `A shell step failed because it tried to change into ${missingShellPath}, which does not exist in this sandbox. I should have rerun that command from the run workspace instead; if you need that exact machine-specific path, run it in your local terminal.`;
  }

  if (isGitShellFailure(event)) {
    return "I couldn't finish the git step in the sandbox because the shell command was malformed for the bounded executor. Retry the step so it uses the dedicated git action, or complete the git command in your local terminal.";
  }

  if (isNonFastForwardPushFailure(event)) {
    return "I couldn't finish the push because the remote branch already had newer commits. Your file changes were already committed locally, so they were not lost. Sync the branch with a fast-forward-only pull and retry the push, or resolve the branch conflict in your local terminal.";
  }

  if (isMissingLocalPushRefFailure(event)) {
    return "I couldn't finish the push because the local branch ref was missing in the resumed workspace. The recovery step should have re-opened the branch before pushing. Retry the step so LegionCode re-syncs the workspace branch first, or finish the branch repair in your local terminal.";
  }

  if (isPullRequestShellFailure(event)) {
    return "I couldn't finish the pull request step because it was attempted through bash instead of the dedicated GitHub-backed PR action. Retry the step so it creates the PR with the dedicated tool, or open the PR manually in your local terminal.";
  }

  if (isGitMutationGateFailure(event)) {
    return [
      "I couldn't finish the push because the safety gate did not find a successful file edit or committed-change handoff for this run.",
      `The tool reported: ${summarizeLifecycleDetail(event.detail)}`,
      "No new commit or pull request was created.",
      "Retry after committing the intended changes, or ask me to push/create the PR from an already committed branch.",
    ].join(" ");
  }

  const missingPackageScript = extractMissingPackageScriptFailure(event);
  if (missingPackageScript) {
    return `A shell step failed because this workspace does not define a script named "${missingPackageScript.scriptName}". I should rerun the correct script for this repository after checking available scripts.`;
  }

  if (event.toolName === "bash") {
    return `A shell step failed: ${summarizeLifecycleDetail(event.detail)}`;
  }

  return `A required ${describeToolAction(event.toolName)} step failed: ${summarizeLifecycleDetail(
    event.detail,
  )}`;
}

function extractMissingShellPath(
  event: AgenticLoopToolLifecycleEvent,
): string | null {
  if (event.toolName !== "bash") {
    return null;
  }

  const missingPathPattern = /\bcd:\s+(.+?): No such file or directory/i;
  const detailMatch = event.detail?.match(missingPathPattern)?.[1];
  if (detailMatch) {
    return detailMatch;
  }

  if (event.metadata?.family !== "shell") {
    return null;
  }

  return event.metadata.stderr?.match(missingPathPattern)?.[1] ?? null;
}

function summarizeLifecycleDetail(detail: string | undefined): string {
  const normalized = detail?.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "The tool failed without a recorded error message.";
  }

  return normalized.length > 220
    ? `${normalized.slice(0, 217)}...`
    : normalized;
}

function deriveToolFailureResumeHint(
  event: AgenticLoopToolLifecycleEvent | undefined,
): string {
  if (!event) {
    return "Retry the failed step. If it still fails, complete the remaining command in your local terminal.";
  }

  if (extractMissingShellPath(event)) {
    return "Retry the step from the workspace root. If the command truly depends on a local-machine path, run it in your local terminal instead.";
  }

  if (isGitShellFailure(event)) {
    return "Retry the git step so it uses the dedicated git action. If needed, finish the remaining git command in your local terminal.";
  }

  if (isNonFastForwardPushFailure(event)) {
    return "The changes are already committed locally. Retry by syncing the branch with git_pull, then run git_push again. If the pull cannot fast-forward, resolve the branch conflict in your local terminal.";
  }

  if (isMissingLocalPushRefFailure(event)) {
    return "Retry the push after re-opening the correct workspace branch. If the branch ref is still missing, repair or recreate the branch in your local terminal.";
  }

  if (isPullRequestShellFailure(event)) {
    return "Retry the pull request step so it uses the dedicated PR action. If needed, open the pull request from your local terminal.";
  }

  if (isGitMutationGateFailure(event)) {
    return "Retry after committing the intended changes, or ask me to push/create the PR from the already committed branch if the edits are already committed.";
  }

  const missingPackageScript = extractMissingPackageScriptFailure(event);
  if (missingPackageScript) {
    return `This repo does not define "${missingPackageScript.scriptName}". Run \`pnpm run\` (or \`npm run\`) to list scripts, then retry with the correct script command.`;
  }

  if (event.toolName === "bash") {
    return "Retry the shell step. If it keeps failing, run the equivalent command in your local terminal.";
  }

  return "Retry the failed step, or finish it manually in your local terminal if the sandbox cannot complete it.";
}

function getTerminalToolLifecycleEvent(
  events: AgenticLoopToolLifecycleEvent[],
): AgenticLoopToolLifecycleEvent | undefined {
  return [...events].sort(compareLifecycleRecordedAt).at(-1);
}

function compareLifecycleRecordedAt(
  left: AgenticLoopToolLifecycleEvent,
  right: AgenticLoopToolLifecycleEvent,
): number {
  return (
    Date.parse(left.recordedAt || "1970-01-01T00:00:00.000Z") -
    Date.parse(right.recordedAt || "1970-01-01T00:00:00.000Z")
  );
}

function isMutationFocusedGitTool(toolName: string): boolean {
  return (
    toolName === "git_stage" ||
    toolName === "git_commit" ||
    toolName === "git_push" ||
    toolName === "git_pull" ||
    toolName === "git_branch_create" ||
    toolName === "git_branch_switch" ||
    toolName === "git_create_pull_request"
  );
}

function describeToolAction(toolName: string): string {
  switch (toolName) {
    case "read_file":
      return "file read";
    case "list_files":
      return "file listing";
    case "write_file":
      return "file edit";
    case "git_stage":
      return "git staging";
    case "git_commit":
      return "git commit";
    case "git_push":
      return "git push";
    case "git_pull":
      return "git sync";
    case "git_branch_create":
      return "branch create";
    case "git_branch_switch":
      return "branch switch";
    case "git_create_pull_request":
      return "pull request";
    default:
      return "tool";
  }
}

function isGitShellFailure(event: AgenticLoopToolLifecycleEvent): boolean {
  if (event.toolName !== "bash" || event.metadata?.family !== "shell") {
    return false;
  }

  const command = event.metadata.command;
  if (!/\bgit\b/.test(command)) {
    return false;
  }

  const detail = `${event.detail ?? ""} ${event.metadata.stderr ?? ""}`;
  return /invalid command argument/i.test(detail);
}

function isNonFastForwardPushFailure(
  event: AgenticLoopToolLifecycleEvent,
): boolean {
  if (event.toolName !== "git_push") {
    return false;
  }

  const detail = `${event.detail ?? ""}`;
  return /non-fast-forward|tip of your current branch is behind|newer commits|already committed locally/i.test(
    detail,
  );
}

function isMissingLocalPushRefFailure(
  event: AgenticLoopToolLifecycleEvent,
): boolean {
  if (event.toolName !== "git_push") {
    return false;
  }

  const detail = `${event.detail ?? ""}`;
  return /src refspec .* does not match any/i.test(detail);
}

function isPullRequestShellFailure(
  event: AgenticLoopToolLifecycleEvent,
): boolean {
  if (event.toolName !== "bash" || event.metadata?.family !== "shell") {
    return false;
  }

  const command = event.metadata.command;
  if (!/\bgh\s+pr\s+create\b/.test(command)) {
    return false;
  }

  const detail = `${event.detail ?? ""} ${event.metadata.stderr ?? ""}`;
  return /invalid (arguments|command argument)|maximum length|too big/i.test(
    detail,
  );
}

function isGitMutationGateFailure(
  event: AgenticLoopToolLifecycleEvent,
): boolean {
  if (event.toolName !== "git_push") {
    return false;
  }

  const metadata = event.metadata as Record<string, unknown> | undefined;
  const metadataText = metadata
    ? [
        metadata.error,
        metadata.message,
        metadata.reason,
        metadata.detail,
        metadata.stderr,
      ]
        .filter((value): value is string => typeof value === "string")
        .join(" ")
    : "";
  const detail = `${event.detail ?? ""} ${metadataText}`;
  return /no successful file mutation|no successful file mutation or committed-change evidence/i.test(
    detail,
  );
}

function extractMissingPackageScriptFailure(
  event: AgenticLoopToolLifecycleEvent,
): {
  scriptName: string;
} | null {
  if (event.toolName !== "bash" || event.metadata?.family !== "shell") {
    return null;
  }

  const detail = `${event.detail ?? ""} ${event.metadata.stderr ?? ""}`;
  const missingScriptMatch = detail.match(
    /(?:npm|pnpm|yarn)\s+error\s+Missing script:\s*["']?([^"'\n]+)["']?/i,
  );
  const pnpmCodeMatch = detail.match(
    /\bERR_PNPM_NO_SCRIPT\b[^"'\n]*["']?([^"'\n]+)["']?/i,
  );
  const scriptName =
    missingScriptMatch?.[1]?.trim() ?? pnpmCodeMatch?.[1]?.trim() ?? null;

  if (!scriptName) {
    return null;
  }

  return { scriptName };
}

function collectCompletedEditEvents(
  toolLifecycle: AgenticLoopToolLifecycleEvent[],
): Array<
  AgenticLoopToolLifecycleEvent & {
    metadata: EditToolActivityMetadata;
  }
> {
  return getLatestToolLifecycle(toolLifecycle, "completed").flatMap((event) => {
    if (event.metadata?.family !== "edit") {
      return [];
    }

    return [
      {
        ...event,
        metadata: event.metadata,
      },
    ];
  });
}

function mergeEditEvents(
  editEvents: Array<
    AgenticLoopToolLifecycleEvent & {
      metadata: EditToolActivityMetadata;
    }
  >,
): Array<{ filePath: string; additions: number; deletions: number }> {
  const byFile = new Map<
    string,
    { filePath: string; additions: number; deletions: number }
  >();

  for (const event of editEvents) {
    const existing = byFile.get(event.metadata.filePath);
    if (existing) {
      existing.additions += event.metadata.additions;
      existing.deletions += event.metadata.deletions;
      continue;
    }

    byFile.set(event.metadata.filePath, {
      filePath: event.metadata.filePath,
      additions: event.metadata.additions,
      deletions: event.metadata.deletions,
    });
  }

  return [...byFile.values()];
}

function deriveUpdatedTargets(filePaths: string[]): string[] {
  const labels = new Set<string>();

  for (const filePath of filePaths) {
    const segments = filePath.split("/").filter(Boolean);
    const fileName = segments.at(-1) ?? filePath;
    const stem = fileName.replace(/\.[^.]+$/, "").trim();

    if (stem && stem.toLowerCase() !== "index") {
      labels.add(stem);
      continue;
    }

    const parentDirectory = segments.at(-2)?.trim();
    if (parentDirectory) {
      labels.add(parentDirectory);
    }
  }

  return [...labels].slice(0, 6);
}
