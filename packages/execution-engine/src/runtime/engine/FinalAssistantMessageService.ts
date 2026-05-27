import {
  RUN_TERMINAL_STATES,
  type RunTerminalState,
} from "@repo/shared-types";
import { buildFinalSummaryFrame } from "./FinalSummaryBuilder.js";

export type FinalAssistantMessageSource = "model" | "runtime";

export interface FinalAssistantMessageInput {
  runId: string;
  sessionId: string;
  terminalState: RunTerminalState;
  modelText?: string;
  detail?: string;
  nextStep?: string;
  metadata?: Record<string, unknown>;
  useSummaryFrame?: boolean;
}

export interface FinalAssistantMessageResult {
  content: string;
  source: FinalAssistantMessageSource;
  metadata: Record<string, unknown>;
}

export class FinalAssistantMessageService {
  build(input: FinalAssistantMessageInput): FinalAssistantMessageResult {
    const normalizedModelText = normalizeFinalAssistantText(input.modelText);
    const source = normalizedModelText
      ? resolveFinalMessageSource(input.metadata)
      : "runtime";
    const content = normalizedModelText || buildRuntimeFinalText(input);

    return {
      content,
      source,
      metadata: mergeFinalMetadata(input.metadata, input.terminalState, source),
    };
  }
}

function resolveFinalMessageSource(
  metadata: Record<string, unknown> | undefined,
): FinalAssistantMessageSource {
  return typeof metadata?.code === "string" ? "runtime" : "model";
}

export function normalizeFinalAssistantText(value: string | undefined): string {
  if (!value) {
    return "";
  }

  const normalized = stripHiddenAssistantMarkup(value)
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!normalized || isUnusableFinalAssistantText(normalized)) {
    return "";
  }

  return normalized;
}

export function isUnusableFinalAssistantText(value: string): boolean {
  const parsed = parseJsonObject(value);
  if (!parsed) {
    return false;
  }

  const keys = Object.keys(parsed);
  if (keys.length === 0) {
    return true;
  }

  return keys.every((key) => isIgnorableEmptyJsonField(key, parsed[key]));
}

function buildRuntimeFinalText(input: FinalAssistantMessageInput): string {
  if (input.useSummaryFrame) {
    return buildFinalSummaryFrame({
      terminalState: input.terminalState,
      detail: input.detail ?? resolveDefaultDetail(input.terminalState),
      nextStep: input.nextStep ?? resolveDefaultNextStep(input.terminalState),
    });
  }

  const detail = normalizeRuntimeSentence(
    input.detail ?? resolveDefaultDetail(input.terminalState),
  );
  const nextStep = normalizeRuntimeSentence(
    input.nextStep ?? resolveDefaultNextStep(input.terminalState),
  );
  return `${resolveRuntimeOutcome(input.terminalState)}\n\n${detail} ${nextStep}`.trim();
}

function mergeFinalMetadata(
  metadata: Record<string, unknown> | undefined,
  terminalState: RunTerminalState,
  source: FinalAssistantMessageSource,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    terminalState,
    finalMessageSource: source,
  };
}

function resolveRuntimeOutcome(terminalState: RunTerminalState): string {
  switch (terminalState) {
    case RUN_TERMINAL_STATES.COMPLETED:
      return "I finished the run, but the model did not produce a final response.";
    case RUN_TERMINAL_STATES.COMPLETED_WITH_WARNINGS:
      return "I finished part of the run, but there were warnings and the model did not produce a final response.";
    case RUN_TERMINAL_STATES.APPROVAL_DENIED:
      return "I stopped because you denied the requested action.";
    case RUN_TERMINAL_STATES.FAILED_TOOL:
      return "I could not finish because a required tool step failed.";
    case RUN_TERMINAL_STATES.FAILED_VALIDATION:
      return "I could not continue because the request did not pass validation.";
    case RUN_TERMINAL_STATES.FAILED_POLICY:
      return "I could not continue because policy blocked this action.";
    case RUN_TERMINAL_STATES.INTERRUPTED:
      return "The run was interrupted before it completed.";
    case RUN_TERMINAL_STATES.APPROVAL_REQUIRED:
      return "I need your approval before I can continue.";
    case RUN_TERMINAL_STATES.APPROVAL_RESOLVED:
      return "Your approval decision was recorded.";
    case RUN_TERMINAL_STATES.FAILED_RUNTIME:
    default:
      return "I could not finish because the runtime hit an internal error.";
  }
}

function resolveDefaultDetail(terminalState: RunTerminalState): string {
  switch (terminalState) {
    case RUN_TERMINAL_STATES.APPROVAL_DENIED:
      return "The requested action was not run, and I did not make further workspace changes after the denial.";
    case RUN_TERMINAL_STATES.APPROVAL_REQUIRED:
      return "The next action needs an approval decision before execution.";
    case RUN_TERMINAL_STATES.COMPLETED:
      return "The run reached a completed state without a visible model-written final response.";
    case RUN_TERMINAL_STATES.COMPLETED_WITH_WARNINGS:
      return "The run reached a terminal state with warnings and without a visible model-written final response.";
    case RUN_TERMINAL_STATES.INTERRUPTED:
      return "The run stopped before the remaining work could finish.";
    default:
      return "The runtime ended without a visible model-written final response.";
  }
}

function resolveDefaultNextStep(terminalState: RunTerminalState): string {
  switch (terminalState) {
    case RUN_TERMINAL_STATES.APPROVAL_DENIED:
      return "Send a revised instruction or approve a safer action to continue.";
    case RUN_TERMINAL_STATES.APPROVAL_REQUIRED:
      return "Choose an approval action to continue, or deny to stop this path.";
    case RUN_TERMINAL_STATES.COMPLETED:
      return "Send the next task when you want me to continue.";
    case RUN_TERMINAL_STATES.COMPLETED_WITH_WARNINGS:
      return "Review the warning details and tell me which part to continue.";
    case RUN_TERMINAL_STATES.INTERRUPTED:
      return "Resubmit the request when you want me to continue.";
    default:
      return "Retry the request or send a narrower follow-up.";
  }
}

function normalizeRuntimeSentence(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  return /[.!?]$/.test(normalized) ? normalized : `${normalized}.`;
}

function stripHiddenAssistantMarkup(value: string): string {
  return value.replace(
    /<(analysis|thinking|reasoning|internal|tool_call|tool_result)\b[^>]*>[\s\S]*?<\/\1>/gi,
    "",
  );
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

const DESCRIPTOR_KEYS = new Set([
  "tool",
  "type",
  "name",
  "arguments",
]);

function isIgnorableEmptyJsonField(key: string, value: unknown): boolean {
  const normalizedKey = key.trim().toLowerCase();
  if (DESCRIPTOR_KEYS.has(normalizedKey)) {
    if (value === null) return true;
    if (typeof value === "string") return true;
    if (typeof value === "object") {
      if (Array.isArray(value)) return value.length === 0;
      return Object.keys(value as Record<string, unknown>).length === 0;
    }
    return true;
  }
  if (normalizedKey === "success" && value === true) {
    return true;
  }
  if (
    (normalizedKey === "output" ||
      normalizedKey === "stdout" ||
      normalizedKey === "stderr" ||
      normalizedKey === "message") &&
    typeof value === "string" &&
    value.trim() === ""
  ) {
    return true;
  }
  return value === null;
}
